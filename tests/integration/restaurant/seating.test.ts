import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { tableSessions, tableSessionTables } from "@/db/schema";
import { AuthorizationError } from "@/shared/errors/app-error";
import { seatParty } from "@/workflows/seat-party/seat-party";
import { changeTableCondition } from "@/modules/restaurant/services/table-service";

import { ABSENT_ID, actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  createRestaurantScenario,
  hostActor,
  putOnShift,
  serverFixture,
  sessionMemberships,
  sessionOverrides,
  sessionRow,
  tableFixture,
  tableRow,
  type RestaurantScenario,
} from "../../fixtures/restaurant-fixtures";

const database = () => getDatabase();

describe("seating", () => {
  let scenario: RestaurantScenario;

  beforeEach(async () => {
    scenario = await createRestaurantScenario(database());
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  const sessionsAt = async (tableIds: string[]) =>
    database()
      .select()
      .from(tableSessionTables)
      .where(inArray(tableSessionTables.restaurantTableId, tableIds));

  it("seats one clean table and leaves its condition unchanged", async () => {
    const table = await tableFixture(database(), scenario);
    const session = await seatParty(database(), scenario.owner, {
      tableIds: [table],
      partySize: 3,
      serverEmployeeId: null,
    });

    expect(await sessionRow(database(), session.id)).toMatchObject({
      status: "ACTIVE",
      partySize: 3,
      createdByUserId: scenario.owner.userId,
      completedAt: null,
    });
    expect(await sessionMemberships(database(), session.id)).toMatchObject([
      { restaurantTableId: table, leftAt: null },
    ]);
    expect((await tableRow(database(), table)).condition).toBe("CLEAN");
  });

  it("seats combined tables under one session, with no duplicate table rows", async () => {
    const first = await tableFixture(database(), scenario);
    const second = await tableFixture(database(), scenario);
    const session = await seatParty(database(), scenario.owner, {
      tableIds: [first, second],
      partySize: 8,
      serverEmployeeId: null,
    });

    expect(
      (await sessionMemberships(database(), session.id))
        .map((row) => row.restaurantTableId)
        .sort(),
    ).toEqual([first, second].sort());
  });

  it("counts a table named twice only once", async () => {
    const table = await tableFixture(database(), scenario, { capacity: 2 });
    const host = await hostActor(database(), scenario);

    await expect(
      seatParty(database(), host, {
        tableIds: [table, table],
        partySize: 4,
        serverEmployeeId: null,
      }),
    ).rejects.toMatchObject({ code: "PARTY_EXCEEDS_CAPACITY" });
  });

  it("refuses tables in different areas", async () => {
    await expect(
      seatParty(database(), scenario.owner, {
        tableIds: [
          await tableFixture(database(), scenario),
          await tableFixture(database(), scenario, { areaId: scenario.bar }),
        ],
        partySize: 2,
        serverEmployeeId: null,
      }),
    ).rejects.toMatchObject({ code: "TABLES_IN_DIFFERENT_AREAS" });
  });

  it("allows more than three tables, since the cap is only for recommendations", async () => {
    const tables = [
      await tableFixture(database(), scenario),
      await tableFixture(database(), scenario),
      await tableFixture(database(), scenario),
      await tableFixture(database(), scenario),
    ];

    await expect(
      seatParty(database(), scenario.owner, {
        tableIds: tables,
        partySize: 14,
        serverEmployeeId: null,
      }),
    ).resolves.toBeDefined();
  });

  it("refuses an occupied table", async () => {
    const table = await tableFixture(database(), scenario);
    const seat = () =>
      seatParty(database(), scenario.owner, {
        tableIds: [table],
        partySize: 2,
        serverEmployeeId: null,
      });

    await seat();

    await expect(seat()).rejects.toMatchObject({
      code: "TABLE_ALREADY_OCCUPIED",
      httpStatus: 409,
    });
  });

  it("refuses a table at another location as absent", async () => {
    const elsewhere = await tableFixture(
      database(),
      { ...scenario, owner: scenario.ownerAtB },
      { areaId: scenario.diningAtB },
    );

    await expect(
      seatParty(database(), scenario.owner, {
        tableIds: [elsewhere],
        partySize: 2,
        serverEmployeeId: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  describe("capacity", () => {
    it("allows a party equal to capacity", async () => {
      const host = await hostActor(database(), scenario);

      await expect(
        seatParty(database(), host, {
          tableIds: [await tableFixture(database(), scenario, { capacity: 4 })],
          partySize: 4,
          serverEmployeeId: null,
        }),
      ).resolves.toBeDefined();
    });

    it("sums combined tables", async () => {
      const host = await hostActor(database(), scenario);

      await expect(
        seatParty(database(), host, {
          tableIds: [
            await tableFixture(database(), scenario, { capacity: 4 }),
            await tableFixture(database(), scenario, { capacity: 2 }),
          ],
          partySize: 6,
          serverEmployeeId: null,
        }),
      ).resolves.toBeDefined();
    });

    it("denies a regular host going over capacity", async () => {
      const host = await hostActor(database(), scenario);

      await expect(
        seatParty(database(), host, {
          tableIds: [await tableFixture(database(), scenario, { capacity: 2 })],
          partySize: 3,
          serverEmployeeId: null,
        }),
      ).rejects.toMatchObject({ code: "PARTY_EXCEEDS_CAPACITY" });
    });

    it("refuses a host who tries to send an override reason", async () => {
      const host = await hostActor(database(), scenario);

      await expect(
        seatParty(database(), host, {
          tableIds: [await tableFixture(database(), scenario, { capacity: 2 })],
          partySize: 3,
          serverEmployeeId: null,
          capacityOverrideReason: "Please",
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("requires a reason from a manager, and records it", async () => {
      const manager = await actorWith(database(), scenario, [
        "restaurant.seat",
        "restaurant.capacity.override",
      ]);
      const table = await tableFixture(database(), scenario, { capacity: 2 });
      const input = { tableIds: [table], partySize: 3, serverEmployeeId: null };

      await expect(seatParty(database(), manager, input)).rejects.toMatchObject({
        code: "CAPACITY_OVERRIDE_REASON_REQUIRED",
      });

      const session = await seatParty(database(), manager, {
        ...input,
        capacityOverrideReason: "Extra chair",
      });

      expect(await sessionOverrides(database(), session.id)).toMatchObject([
        {
          overrideType: "CAPACITY",
          reason: "Extra chair",
          overriddenByUserId: manager.userId,
          partySize: 3,
          seatedCapacity: 2,
        },
      ]);
    });

    it("records no override when none was needed", async () => {
      const session = await seatParty(database(), scenario.owner, {
        tableIds: [await tableFixture(database(), scenario, { capacity: 4 })],
        partySize: 2,
        serverEmployeeId: null,
        capacityOverrideReason: "Not needed",
      });

      expect(await sessionOverrides(database(), session.id)).toEqual([]);
    });
  });

  describe("server", () => {
    it("stores a qualified, scheduled server", async () => {
      const host = await hostActor(database(), scenario);
      const server = await serverFixture(database(), scenario);

      await putOnShift(database(), scenario, server, scenario.server);

      const session = await seatParty(database(), host, {
        tableIds: [await tableFixture(database(), scenario)],
        partySize: 2,
        serverEmployeeId: server,
      });

      expect(
        (await sessionRow(database(), session.id)).assignedServerEmployeeId,
      ).toBe(server);
      expect(await sessionOverrides(database(), session.id)).toEqual([]);
    });

    it("refuses an unqualified server with no partial session", async () => {
      const host = await hostActor(database(), scenario);
      const cook = await serverFixture(database(), scenario, scenario.cook);
      const table = await tableFixture(database(), scenario);

      await putOnShift(database(), scenario, cook, scenario.cook);

      await expect(
        seatParty(database(), host, {
          tableIds: [table],
          partySize: 2,
          serverEmployeeId: cook,
        }),
      ).rejects.toMatchObject({ code: "SERVER_NOT_QUALIFIED" });
      expect(await sessionsAt([table])).toEqual([]);
    });

    it("needs the assign permission to name a server", async () => {
      const seater = await actorWith(database(), scenario, ["restaurant.seat"]);

      await expect(
        seatParty(database(), seater, {
          tableIds: [await tableFixture(database(), scenario)],
          partySize: 2,
          serverEmployeeId: await serverFixture(database(), scenario),
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("treats an unknown employee like any unqualified one", async () => {
      await expect(
        seatParty(database(), scenario.owner, {
          tableIds: [await tableFixture(database(), scenario)],
          partySize: 2,
          serverEmployeeId: ABSENT_ID,
        }),
      ).rejects.toMatchObject({ code: "SERVER_NOT_QUALIFIED" });
    });

    it("records a schedule override with its reason", async () => {
      const server = await serverFixture(database(), scenario);
      const session = await seatParty(database(), scenario.owner, {
        tableIds: [await tableFixture(database(), scenario)],
        partySize: 2,
        serverEmployeeId: server,
        scheduleOverrideReason: "Covering a sick call",
      });

      expect(await sessionOverrides(database(), session.id)).toMatchObject([
        {
          overrideType: "SERVER_SCHEDULE",
          reason: "Covering a sick call",
          serverEmployeeId: server,
          overriddenByUserId: scenario.owner.userId,
        },
      ]);
    });
  });

  describe("concurrency", () => {
    it("lets exactly one of two hosts take the same table", async () => {
      const table = await tableFixture(database(), scenario);
      const seat = () =>
        seatParty(database(), scenario.owner, {
          tableIds: [table],
          partySize: 2,
          serverEmployeeId: null,
        });
      const results = await Promise.allSettled([seat(), seat()]);
      const rejected = results.filter((result) => result.status === "rejected");

      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        reason: { code: "TABLE_ALREADY_OCCUPIED" },
      });
      expect(await sessionsAt([table])).toHaveLength(1);
    });

    it("stays correct across many simultaneous attempts", async () => {
      const table = await tableFixture(database(), scenario);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          seatParty(database(), scenario.owner, {
            tableIds: [table],
            partySize: 2,
            serverEmployeeId: null,
          }),
        ),
      );

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(await sessionsAt([table])).toHaveLength(1);
    });

    it("lets one of two overlapping combinations win, whichever order they lock", async () => {
      const a = await tableFixture(database(), scenario);
      const b = await tableFixture(database(), scenario);
      const c = await tableFixture(database(), scenario);
      const results = await Promise.allSettled([
        seatParty(database(), scenario.owner, {
          tableIds: [a, b],
          partySize: 2,
          serverEmployeeId: null,
        }),
        seatParty(database(), scenario.owner, {
          tableIds: [c, b],
          partySize: 2,
          serverEmployeeId: null,
        }),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);

      const open = await sessionsAt([a, b, c]);

      expect(open).toHaveLength(2);
      expect(new Set(open.map((row) => row.tableSessionId)).size).toBe(1);
    });

    it("leaves no session when a combination loses one table", async () => {
      const free = await tableFixture(database(), scenario);
      const taken = await tableFixture(database(), scenario);

      await seatParty(database(), scenario.owner, {
        tableIds: [taken],
        partySize: 2,
        serverEmployeeId: null,
      });

      const before = await database().select().from(tableSessions);

      await expect(
        seatParty(database(), scenario.owner, {
          tableIds: [free, taken],
          partySize: 2,
          serverEmployeeId: null,
        }),
      ).rejects.toMatchObject({ code: "TABLE_ALREADY_OCCUPIED" });

      expect(await database().select().from(tableSessions)).toHaveLength(
        before.length,
      );
      expect(await sessionsAt([free])).toEqual([]);
    });

    it("sees a condition change made while waiting for the lock", async () => {
      const table = await tableFixture(database(), scenario);
      const results = await Promise.allSettled([
        changeTableCondition(database(), scenario.owner, table, {
          condition: "OUT_OF_SERVICE",
          reason: null,
          expectedVersion: 1,
        }),
        seatParty(database(), scenario.owner, {
          tableIds: [table],
          partySize: 2,
          serverEmployeeId: null,
        }),
      ]);
      const row = await tableRow(database(), table);
      const open = await sessionsAt([table]);

      // Either order is valid; the contradictory outcome is not.
      expect(row.condition === "OUT_OF_SERVICE" && open.length === 1).toBe(false);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });

    it("rejects a second open membership in PostgreSQL itself", async () => {
      const table = await tableFixture(database(), scenario);
      const session = await seatParty(database(), scenario.owner, {
        tableIds: [table],
        partySize: 2,
        serverEmployeeId: null,
      });
      const other = await seatParty(database(), scenario.owner, {
        tableIds: [await tableFixture(database(), scenario)],
        partySize: 2,
        serverEmployeeId: null,
      });

      await expect(
        database().insert(tableSessionTables).values({
          tableSessionId: other.id,
          locationId: scenario.locationA,
          restaurantTableId: table,
        }),
      ).rejects.toThrow();

      const rows = await database()
        .select()
        .from(tableSessionTables)
        .where(eq(tableSessionTables.restaurantTableId, table));

      expect(rows.map((row) => row.tableSessionId)).toEqual([session.id]);
    });

    it("refuses a membership across locations in PostgreSQL", async () => {
      const elsewhere = await tableFixture(
        database(),
        { ...scenario, owner: scenario.ownerAtB },
        { areaId: scenario.diningAtB },
      );
      const session = await seatParty(database(), scenario.owner, {
        tableIds: [await tableFixture(database(), scenario)],
        partySize: 2,
        serverEmployeeId: null,
      });

      await expect(
        database().insert(tableSessionTables).values({
          tableSessionId: session.id,
          locationId: scenario.locationA,
          restaurantTableId: elsewhere,
        }),
      ).rejects.toThrow();
    });
  });
});
