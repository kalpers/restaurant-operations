import { and, asc, eq, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { assertVersionMatched, nextVersion } from "@/db/helpers/versioning";
import { readErrorCode } from "@/infrastructure/health/check-database-health";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  clearFixtureTables,
  createFixtureTables,
  dropFixtureTables,
  fixtureChildren,
  fixtureParents,
} from "../../fixtures/convention-fixtures";

async function caughtErrorCode(operation: Promise<unknown>) {
  const error = await operation.then(
    () => undefined,
    (caught: unknown) => caught,
  );

  return readErrorCode(error);
}

describe("database conventions", () => {
  beforeAll(async () => {
    await createFixtureTables(getDatabase());
  });

  beforeEach(async () => {
    await clearFixtureTables(getDatabase());
  });

  afterAll(async () => {
    await dropFixtureTables(getDatabase());
    await closeDatabase();
  });

  describe("UUID primary keys and defaults", () => {
    it("generates distinct UUIDs and applies active and version defaults", async () => {
      const rows = await getDatabase()
        .insert(fixtureParents)
        .values([
          { code: "A", label: "first" },
          { code: "B", label: "second" },
        ])
        .returning();

      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      expect(rows[0]?.id).toMatch(uuid);
      expect(rows[0]?.id).not.toBe(rows[1]?.id);
      expect(rows[0]).toMatchObject({ active: true, version: 1 });
    });
  });

  describe("numeric precision", () => {
    it.each([
      "123.4567",
      "0.1000",
      "999999.9999",
      "0.0001",
      "-0.2500",
      "8.0000",
      "44.3600",
      "9999999999.9999",
      "-9999999999.9999",
    ])("preserves %s in cost and quantity columns", async (value) => {
      const [row] = await getDatabase()
        .insert(fixtureChildren)
        .values({ unitCost: value, onHand: value })
        .returning();

      expect(row).toMatchObject({ unitCost: value, onHand: value });
    });

    it.each(["0.10", "0.00", "19.99", "9999999999.99"])(
      "preserves %s in money columns",
      async (value) => {
        const [row] = await getDatabase()
          .insert(fixtureChildren)
          .values({ amount: value })
          .returning();

        expect(row?.amount).toBe(value);
      },
    );

    it("keeps the scale that converting to a JavaScript number would lose", async () => {
      const value = "0.1000";
      expect(String(Number(value))).toBe("0.1");

      const [row] = await getDatabase()
        .insert(fixtureChildren)
        .values({ onHand: value })
        .returning();

      expect(row?.onHand).toBe(value);
    });

    it("adds exactly in PostgreSQL, where floating point would drift", async () => {
      await getDatabase()
        .insert(fixtureChildren)
        .values([{ onHand: "0.1000" }, { onHand: "0.2000" }]);

      const [row] = await getDatabase()
        .select({ total: sql<string>`sum(${fixtureChildren.onHand})` })
        .from(fixtureChildren);

      expect(0.1 + 0.2).not.toBe(0.3);
      expect(row?.total).toBe("0.3000");
    });

    it("pads values to the column's scale", async () => {
      const [row] = await getDatabase()
        .insert(fixtureChildren)
        .values({ amount: "5", onHand: "3.75" })
        .returning();

      expect(row).toMatchObject({ amount: "5.00", onHand: "3.7500" });
    });

    it("rounds extra decimals, so domains must validate input scale", async () => {
      const [row] = await getDatabase()
        .insert(fixtureChildren)
        .values({ amount: "1.005" })
        .returning();

      expect(row?.amount).toBe("1.01");
    });

    it("rejects values beyond the column's precision", async () => {
      const code = await caughtErrorCode(
        getDatabase()
          .insert(fixtureChildren)
          .values({ amount: "99999999999.00" })
          .returning(),
      );

      expect(code).toBe("22003");
    });
  });

  describe("TIMESTAMPTZ", () => {
    it.each([
      ["with milliseconds", "2026-03-14T05:15:30.123Z"],
      ["just before a US daylight-saving jump", "2026-03-08T06:59:59.999Z"],
      ["just after a US daylight-saving jump", "2026-03-08T07:00:00.000Z"],
      ["at the year boundary", "2026-12-31T23:59:59.000Z"],
    ])("preserves an instant %s", async (_label, instant) => {
      const [row] = await getDatabase()
        .insert(fixtureChildren)
        .values({ occurredAt: new Date(instant) })
        .returning();

      expect(row?.occurredAt).toBeInstanceOf(Date);
      expect(row?.occurredAt?.toISOString()).toBe(instant);
    });

    it("keeps the instant when the session timezone differs", async () => {
      const instant = "2026-03-14T05:15:30.000Z";

      const result = await getDatabase().transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL TIME ZONE 'Asia/Tokyo'`);

        const [inserted] = await transaction
          .insert(fixtureChildren)
          .values({ occurredAt: new Date(instant) })
          .returning();

        const [display] = await transaction.execute(
          sql`SELECT to_char(${fixtureChildren.occurredAt}, 'YYYY-MM-DD HH24:MI') AS local_time
              FROM ${fixtureChildren}`,
        );

        return { inserted, localTime: display?.local_time };
      });

      expect(result.inserted?.occurredAt?.toISOString()).toBe(instant);
      expect(result.localTime).toBe("2026-03-14 14:15");

      const [stored] = await getDatabase()
        .select({ occurredAt: fixtureChildren.occurredAt })
        .from(fixtureChildren);
      expect(stored?.occurredAt?.toISOString()).toBe(instant);
    });

    it("stores the business date separately from the instant", async () => {
      // Saturday 1:15 AM in Detroit can belong to Friday's business date.
      const [row] = await getDatabase()
        .insert(fixtureChildren)
        .values({
          occurredAt: new Date("2026-03-14T05:15:00.000Z"),
          businessDate: "2026-03-13",
        })
        .returning();

      expect(row?.businessDate).toBe("2026-03-13");
      expect(row?.occurredAt?.toISOString()).toBe("2026-03-14T05:15:00.000Z");
    });

    it("returns the business date unchanged in any session timezone", async () => {
      await getDatabase()
        .insert(fixtureChildren)
        .values({ businessDate: "2026-03-13" });

      const dates = await getDatabase().transaction(async (transaction) => {
        const found: (string | null | undefined)[] = [];

        for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
          await transaction.execute(sql.raw(`SET LOCAL TIME ZONE '${zone}'`));
          const [row] = await transaction
            .select({ businessDate: fixtureChildren.businessDate })
            .from(fixtureChildren);
          found.push(row?.businessDate);
        }

        return found;
      });

      expect(dates).toEqual(["2026-03-13", "2026-03-13"]);
    });

    it("sets created_at and advances updated_at on update", async () => {
      const database = getDatabase();
      const [created] = await database
        .insert(fixtureParents)
        .values({ code: "A", label: "first" })
        .returning();

      const before = created?.updatedAt.getTime() ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 5));

      const [updated] = await database
        .update(fixtureParents)
        .set({ label: "changed" })
        .where(eq(fixtureParents.code, "A"))
        .returning();

      expect(created?.createdAt).toBeInstanceOf(Date);
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(before);
      expect(updated?.createdAt).toEqual(created?.createdAt);
    });
  });

  describe("constraints", () => {
    it("enforces unique constraints", async () => {
      const database = getDatabase();
      await database.insert(fixtureParents).values({ code: "A", label: "first" });

      const code = await caughtErrorCode(
        database
          .insert(fixtureParents)
          .values({ code: "A", label: "second" })
          .returning(),
      );

      expect(code).toBe("23505");
    });

    it("enforces primary keys", async () => {
      const database = getDatabase();
      const [row] = await database
        .insert(fixtureParents)
        .values({ code: "A", label: "first" })
        .returning();

      const code = await caughtErrorCode(
        database
          .insert(fixtureParents)
          .values({ id: row?.id, code: "B", label: "second" })
          .returning(),
      );

      expect(code).toBe("23505");
    });

    it("enforces foreign keys", async () => {
      const code = await caughtErrorCode(
        getDatabase()
          .insert(fixtureChildren)
          .values({ parentId: "00000000-0000-4000-8000-000000000000" })
          .returning(),
      );

      expect(code).toBe("23503");
    });

    it("enforces check constraints", async () => {
      const code = await caughtErrorCode(
        getDatabase()
          .insert(fixtureChildren)
          .values({ amount: "-0.01" })
          .returning(),
      );

      expect(code).toBe("23514");
    });

    it("enforces not-null columns", async () => {
      const code = await caughtErrorCode(
        getDatabase().execute(
          sql`INSERT INTO fixture_parents (code, label) VALUES ('A', NULL)`,
        ),
      );

      expect(code).toBe("23502");
    });
  });

  describe("optimistic concurrency", () => {
    async function updateLabel(id: string, expectedVersion: number, label: string) {
      const rows = await getDatabase()
        .update(fixtureParents)
        .set({ label, version: nextVersion(fixtureParents.version) })
        .where(
          and(
            eq(fixtureParents.id, id),
            eq(fixtureParents.version, expectedVersion),
          ),
        )
        .returning();

      return assertVersionMatched(rows, { type: "fixture parent", id });
    }

    async function insertParent() {
      const [row] = await getDatabase()
        .insert(fixtureParents)
        .values({ code: "A", label: "original" })
        .returning();

      if (!row) {
        throw new Error("Expected a fixture row");
      }

      return row;
    }

    it("increments the version and detects a stale update", async () => {
      const { id } = await insertParent();

      const clientA = await updateLabel(id, 1, "from client A");
      expect(clientA.version).toBe(2);

      await expect(updateLabel(id, 1, "from client B")).rejects.toThrow(
        ConcurrencyError,
      );

      const [stored] = await getDatabase()
        .select()
        .from(fixtureParents)
        .where(eq(fixtureParents.id, id));
      expect(stored).toMatchObject({ label: "from client A", version: 2 });
    });

    it("lets exactly one of two simultaneous updates win", async () => {
      const { id } = await insertParent();

      const results = await Promise.allSettled([
        updateLabel(id, 1, "first"),
        updateLabel(id, 1, "second"),
      ]);

      const rejected = results.filter((result) => result.status === "rejected");
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(ConcurrencyError);

      const [stored] = await getDatabase()
        .select({ version: fixtureParents.version })
        .from(fixtureParents)
        .orderBy(asc(fixtureParents.id));
      expect(stored?.version).toBe(2);
    });

    it("reports a conflict for a missing record", async () => {
      await expect(
        updateLabel("00000000-0000-4000-8000-000000000000", 1, "x"),
      ).rejects.toThrow(ConcurrencyError);
    });
  });
});
