import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  addTableToSession,
  assignSessionServer,
  cancelSession,
  completeSession,
  moveSession,
  removeTableFromSession,
} from "@/modules/restaurant/services/session-service";
import { changeTableCondition } from "@/modules/restaurant/services/table-service";
import { AuthorizationError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { seatParty } from "@/workflows/seat-party/seat-party";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  conditionHistory,
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

describe("table sessions", () => {
  let scenario: RestaurantScenario;

  beforeEach(async () => {
    scenario = await createRestaurantScenario(database());
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  async function seated(
    tableIds: string[],
    partySize = 2,
    serverEmployeeId: string | null = null,
  ) {
    return seatParty(database(), scenario.owner, {
      tableIds,
      partySize,
      serverEmployeeId,
      scheduleOverrideReason: serverEmployeeId ? "Fixture" : null,
    });
  }

  const openTables = async (sessionId: string) =>
    (await sessionMemberships(database(), sessionId))
      .filter((row) => row.leftAt === null)
      .map((row) => row.restaurantTableId)
      .sort();

  describe("move", () => {
    it("moves to a clean table in the same session, and the old table becomes DIRTY", async () => {
      const from = await tableFixture(database(), scenario);
      const to = await tableFixture(database(), scenario);
      const session = await seated([from]);
      const moved = await moveSession(database(), scenario.owner, session.id, {
        tableIds: [to],
        expectedVersion: session.version,
      });

      expect(moved.id).toBe(session.id);
      expect(moved.version).toBe(session.version + 1);
      expect(await openTables(session.id)).toEqual([to]);
      expect((await tableRow(database(), from)).condition).toBe("DIRTY");
      expect((await tableRow(database(), to)).condition).toBe("CLEAN");
      expect(await conditionHistory(database(), from)).toMatchObject([
        { condition: "CLEAN" },
        { condition: "DIRTY", reason: "Party moved" },
      ]);
    });

    it("preserves membership history", async () => {
      const from = await tableFixture(database(), scenario);
      const to = await tableFixture(database(), scenario);
      const session = await seated([from]);

      await moveSession(database(), scenario.owner, session.id, {
        tableIds: [to],
        expectedVersion: session.version,
      });

      const rows = await sessionMemberships(database(), session.id);

      expect(rows).toHaveLength(2);
      expect(
        rows.find((row) => row.restaurantTableId === from)?.leftAt,
      ).toBeInstanceOf(Date);
    });

    it("moves many tables to one, and one to many", async () => {
      const [a, b, c, d] = [
        await tableFixture(database(), scenario),
        await tableFixture(database(), scenario),
        await tableFixture(database(), scenario),
        await tableFixture(database(), scenario),
      ];
      const session = await seated([a!, b!]);
      const first = await moveSession(database(), scenario.owner, session.id, {
        tableIds: [c!],
        expectedVersion: session.version,
      });

      expect(await openTables(session.id)).toEqual([c]);

      await moveSession(database(), scenario.owner, session.id, {
        tableIds: [c!, d!],
        expectedVersion: first.version,
      });
      expect(await openTables(session.id)).toEqual([c, d].sort());
    });

    it("keeps a table in both sets, without dirtying it", async () => {
      const keep = await tableFixture(database(), scenario);
      const leave = await tableFixture(database(), scenario);
      const join = await tableFixture(database(), scenario);
      const session = await seated([keep, leave]);

      await moveSession(database(), scenario.owner, session.id, {
        tableIds: [keep, join],
        expectedVersion: session.version,
      });

      expect((await tableRow(database(), keep)).condition).toBe("CLEAN");
      expect((await tableRow(database(), leave)).condition).toBe("DIRTY");
      expect(await openTables(session.id)).toEqual([keep, join].sort());
    });

    it("refuses an occupied, dirty or out-of-service target and changes nothing", async () => {
      const from = await tableFixture(database(), scenario);
      const session = await seated([from]);
      const occupied = await tableFixture(database(), scenario);
      const dirtySource = await tableFixture(database(), scenario);
      const out = await tableFixture(database(), scenario);

      await seated([occupied]);
      const other = await seated([dirtySource]);

      await completeSession(database(), scenario.owner, other.id, {
        expectedVersion: other.version,
      });
      await changeTableCondition(database(), scenario.owner, out, {
        condition: "OUT_OF_SERVICE",
        reason: null,
        expectedVersion: 1,
      });

      for (const [target, code] of [
        [occupied, "TABLE_ALREADY_OCCUPIED"],
        [dirtySource, "TABLE_DIRTY"],
        [out, "TABLE_OUT_OF_SERVICE"],
      ] as const) {
        await expect(
          moveSession(database(), scenario.owner, session.id, {
            tableIds: [target],
            expectedVersion: session.version,
          }),
        ).rejects.toMatchObject({ code });
      }

      expect(await openTables(session.id)).toEqual([from]);
      expect((await tableRow(database(), from)).condition).toBe("CLEAN");
      expect((await sessionRow(database(), session.id)).version).toBe(
        session.version,
      );
    });

    it("moves to the whole target set or stays put", async () => {
      const from = await tableFixture(database(), scenario);
      const free = await tableFixture(database(), scenario);
      const taken = await tableFixture(database(), scenario);
      const session = await seated([from]);

      await seated([taken]);

      await expect(
        moveSession(database(), scenario.owner, session.id, {
          tableIds: [free, taken],
          expectedVersion: session.version,
        }),
      ).rejects.toMatchObject({ code: "TABLE_ALREADY_OCCUPIED" });

      expect(await openTables(session.id)).toEqual([from]);
      expect((await tableRow(database(), free)).condition).toBe("CLEAN");
    });

    it("applies capacity to the target, with an override and reason", async () => {
      const from = await tableFixture(database(), scenario, { capacity: 6 });
      const small = await tableFixture(database(), scenario, { capacity: 2 });
      const session = await seated([from], 5);
      const host = await hostActor(database(), scenario);

      await expect(
        moveSession(database(), host, session.id, {
          tableIds: [small],
          expectedVersion: session.version,
        }),
      ).rejects.toMatchObject({ code: "PARTY_EXCEEDS_CAPACITY" });

      await moveSession(database(), scenario.owner, session.id, {
        tableIds: [small],
        capacityOverrideReason: "They asked to squeeze in",
        expectedVersion: session.version,
      });

      expect(await sessionOverrides(database(), session.id)).toMatchObject([
        { overrideType: "CAPACITY", partySize: 5, seatedCapacity: 2 },
      ]);
    });

    it("keeps every override reason across repeated overrides", async () => {
      const a = await tableFixture(database(), scenario, { capacity: 2 });
      const b = await tableFixture(database(), scenario, { capacity: 2 });
      const session = await seatParty(database(), scenario.owner, {
        tableIds: [a],
        partySize: 5,
        serverEmployeeId: null,
        capacityOverrideReason: "First",
      });

      await moveSession(database(), scenario.owner, session.id, {
        tableIds: [b],
        capacityOverrideReason: "Second",
        expectedVersion: session.version,
      });

      expect(
        (await sessionOverrides(database(), session.id))
          .map((row) => row.reason)
          .sort(),
      ).toEqual(["First", "Second"]);
    });

    it("refuses a stale move and one to the same tables", async () => {
      const from = await tableFixture(database(), scenario);
      const to = await tableFixture(database(), scenario);
      const session = await seated([from]);

      await expect(
        moveSession(database(), scenario.owner, session.id, {
          tableIds: [to],
          expectedVersion: session.version + 1,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
      await expect(
        moveSession(database(), scenario.owner, session.id, {
          tableIds: [from],
          expectedVersion: session.version,
        }),
      ).rejects.toMatchObject({ code: "SESSION_TABLES_UNCHANGED" });
    });

    it("refuses moving across areas with a server who can't work the new one", async () => {
      const bar = await tableFixture(database(), scenario, { areaId: scenario.bar });
      const dining = await tableFixture(database(), scenario);
      const bartender = await serverFixture(database(), scenario, scenario.bartender);
      const session = await seated([bar], 2, bartender);

      await expect(
        moveSession(database(), scenario.owner, session.id, {
          tableIds: [dining],
          expectedVersion: session.version,
        }),
      ).rejects.toMatchObject({ code: "SERVER_NOT_QUALIFIED_FOR_AREA" });
      expect(await openTables(session.id)).toEqual([bar]);
    });

    it("allows moving across areas with a server qualified for both", async () => {
      const dining = await tableFixture(database(), scenario);
      const bar = await tableFixture(database(), scenario, { areaId: scenario.bar });
      const server = await serverFixture(database(), scenario);
      const session = await seated([dining], 2, server);

      await moveSession(database(), scenario.owner, session.id, {
        tableIds: [bar],
        expectedVersion: session.version,
      });
      expect(await openTables(session.id)).toEqual([bar]);
    });

    it("lets one of two simultaneous moves to one table win", async () => {
      const target = await tableFixture(database(), scenario);
      const first = await seated([await tableFixture(database(), scenario)]);
      const second = await seated([await tableFixture(database(), scenario)]);
      const results = await Promise.allSettled([
        moveSession(database(), scenario.owner, first.id, {
          tableIds: [target],
          expectedVersion: first.version,
        }),
        moveSession(database(), scenario.owner, second.id, {
          tableIds: [target],
          expectedVersion: second.version,
        }),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        [
          ...(await openTables(first.id)),
          ...(await openTables(second.id)),
        ].filter((id) => id === target),
      ).toHaveLength(1);
    });
  });

  describe("add and remove", () => {
    it("combines another table", async () => {
      const a = await tableFixture(database(), scenario);
      const b = await tableFixture(database(), scenario);
      const session = await seated([a]);

      await addTableToSession(database(), scenario.owner, session.id, {
        tableId: b,
        expectedVersion: session.version,
      });

      expect(await openTables(session.id)).toEqual([a, b].sort());
    });

    it("refuses adding a table that isn't clean, is taken, or is in another area", async () => {
      const a = await tableFixture(database(), scenario);
      const session = await seated([a]);
      const taken = await tableFixture(database(), scenario);
      const bar = await tableFixture(database(), scenario, { areaId: scenario.bar });

      await seated([taken]);

      await expect(
        addTableToSession(database(), scenario.owner, session.id, {
          tableId: taken,
          expectedVersion: session.version,
        }),
      ).rejects.toMatchObject({ code: "TABLE_ALREADY_OCCUPIED" });
      await expect(
        addTableToSession(database(), scenario.owner, session.id, {
          tableId: bar,
          expectedVersion: session.version,
        }),
      ).rejects.toMatchObject({ code: "TABLES_IN_DIFFERENT_AREAS" });
      await expect(
        addTableToSession(database(), scenario.owner, session.id, {
          tableId: a,
          expectedVersion: session.version,
        }),
      ).rejects.toMatchObject({ code: "SESSION_TABLES_UNCHANGED" });
    });

    it("removes a combined table, which becomes DIRTY with its row kept", async () => {
      const a = await tableFixture(database(), scenario);
      const b = await tableFixture(database(), scenario);
      const session = await seated([a, b]);

      await removeTableFromSession(database(), scenario.owner, session.id, b, {
        expectedVersion: session.version,
      });

      expect(await openTables(session.id)).toEqual([a]);
      expect((await tableRow(database(), b)).condition).toBe("DIRTY");
      expect(await sessionMemberships(database(), session.id)).toHaveLength(2);
    });

    it("refuses removing the last table", async () => {
      const a = await tableFixture(database(), scenario);
      const session = await seated([a]);

      await expect(
        removeTableFromSession(database(), scenario.owner, session.id, a, {
          expectedVersion: session.version,
        }),
      ).rejects.toMatchObject({ code: "SESSION_NEEDS_A_TABLE" });
    });

    it("refuses a removal that breaks capacity, unless overridden", async () => {
      const a = await tableFixture(database(), scenario, { capacity: 2 });
      const b = await tableFixture(database(), scenario, { capacity: 4 });
      const session = await seated([a, b], 5);
      const host = await hostActor(database(), scenario);

      await expect(
        removeTableFromSession(database(), host, session.id, b, {
          expectedVersion: session.version,
        }),
      ).rejects.toMatchObject({ code: "PARTY_EXCEEDS_CAPACITY" });

      await expect(
        removeTableFromSession(database(), scenario.owner, session.id, b, {
          capacityOverrideReason: "Two left early",
          expectedVersion: session.version,
        }),
      ).resolves.toBeDefined();
    });

    it("can rejoin a table it left, as a new membership row", async () => {
      const a = await tableFixture(database(), scenario);
      const b = await tableFixture(database(), scenario);
      const session = await seated([a, b]);
      const removed = await removeTableFromSession(
        database(),
        scenario.owner,
        session.id,
        b,
        { expectedVersion: session.version },
      );

      await changeTableCondition(database(), scenario.owner, b, {
        condition: "CLEAN",
        reason: null,
        expectedVersion: (await tableRow(database(), b)).version,
      });
      await addTableToSession(database(), scenario.owner, session.id, {
        tableId: b,
        expectedVersion: removed.version,
      });

      expect(await sessionMemberships(database(), session.id)).toHaveLength(3);
    });
  });

  describe("complete", () => {
    it("completes, records who and when, ends memberships and dirties every table", async () => {
      const a = await tableFixture(database(), scenario);
      const b = await tableFixture(database(), scenario);
      const session = await seated([a, b]);

      await completeSession(database(), scenario.owner, session.id, {
        expectedVersion: session.version,
      });

      const row = await sessionRow(database(), session.id);

      expect(row.status).toBe("COMPLETED");
      expect(row.completedAt).toBeInstanceOf(Date);
      expect(row.completedByUserId).toBe(scenario.owner.userId);
      expect(await openTables(session.id)).toEqual([]);

      for (const table of [a, b]) {
        expect((await tableRow(database(), table)).condition).toBe("DIRTY");
        expect((await conditionHistory(database(), table)).at(-1)).toMatchObject({
          condition: "DIRTY",
          reason: "Session completed",
          changedByUserId: scenario.owner.userId,
        });
      }
    });

    it("can't complete twice, and refuses a stale version", async () => {
      const session = await seated([await tableFixture(database(), scenario)]);

      await expect(
        completeSession(database(), scenario.owner, session.id, {
          expectedVersion: session.version + 5,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);

      await completeSession(database(), scenario.owner, session.id, {
        expectedVersion: session.version,
      });

      await expect(
        completeSession(database(), scenario.owner, session.id, {
          expectedVersion: session.version + 1,
        }),
      ).rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
    });

    it("lets one of a simultaneous complete and move win, leaving a consistent table", async () => {
      const from = await tableFixture(database(), scenario);
      const to = await tableFixture(database(), scenario);
      const session = await seated([from]);
      const results = await Promise.allSettled([
        completeSession(database(), scenario.owner, session.id, {
          expectedVersion: session.version,
        }),
        moveSession(database(), scenario.owner, session.id, {
          tableIds: [to],
          expectedVersion: session.version,
        }),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect((await tableRow(database(), from)).condition).toBe("DIRTY");
    });
  });

  describe("cancel", () => {
    it("ends the session, keeps tables clean and records the reason", async () => {
      const table = await tableFixture(database(), scenario);
      const session = await seated([table]);

      await cancelSession(database(), scenario.owner, session.id, {
        reason: "Wrong table",
        expectedVersion: session.version,
      });

      expect(await sessionRow(database(), session.id)).toMatchObject({
        status: "CANCELLED",
        cancelReason: "Wrong table",
        cancelledByUserId: scenario.owner.userId,
        completedAt: null,
      });
      expect(await openTables(session.id)).toEqual([]);
      expect((await tableRow(database(), table)).condition).toBe("CLEAN");
      expect(await conditionHistory(database(), table)).toHaveLength(1);
      await expect(seated([table])).resolves.toBeDefined();
    });

    it("needs its own permission: seating and completing aren't enough", async () => {
      const session = await seated([await tableFixture(database(), scenario)]);
      const host = await hostActor(database(), scenario);

      await expect(
        cancelSession(database(), host, session.id, {
          reason: "Oops",
          expectedVersion: session.version,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("can't cancel an ended session", async () => {
      const session = await seated([await tableFixture(database(), scenario)]);

      await completeSession(database(), scenario.owner, session.id, {
        expectedVersion: session.version,
      });

      await expect(
        cancelSession(database(), scenario.owner, session.id, {
          reason: "Late",
          expectedVersion: session.version + 1,
        }),
      ).rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
    });
  });

  describe("server assignment", () => {
    it("reassigns and clears independently", async () => {
      const first = await serverFixture(database(), scenario);
      const second = await serverFixture(database(), scenario);
      const session = await seated(
        [await tableFixture(database(), scenario)],
        2,
        first,
      );

      await putOnShift(database(), scenario, second, scenario.server);

      const host = await hostActor(database(), scenario);
      const reassigned = await assignSessionServer(database(), host, session.id, {
        serverEmployeeId: second,
        expectedVersion: session.version,
      });

      expect(
        (await sessionRow(database(), session.id)).assignedServerEmployeeId,
      ).toBe(second);

      await assignSessionServer(database(), host, session.id, {
        serverEmployeeId: null,
        expectedVersion: reassigned.version,
      });
      expect(
        (await sessionRow(database(), session.id)).assignedServerEmployeeId,
      ).toBeNull();
    });

    it("assigns an employee with no login", async () => {
      const server = await serverFixture(database(), scenario);
      const session = await seated([await tableFixture(database(), scenario)]);

      await putOnShift(database(), scenario, server, scenario.server);

      await expect(
        assignSessionServer(database(), scenario.owner, session.id, {
          serverEmployeeId: server,
          expectedVersion: session.version,
        }),
      ).resolves.toBeDefined();
    });

    it("refuses a stale reassignment", async () => {
      const server = await serverFixture(database(), scenario);
      const session = await seated([await tableFixture(database(), scenario)]);

      await expect(
        assignSessionServer(database(), scenario.owner, session.id, {
          serverEmployeeId: server,
          scheduleOverrideReason: "Fixture",
          expectedVersion: session.version + 1,
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
    });

    it("needs the assign permission", async () => {
      const actor = await actorWith(database(), scenario, ["restaurant.move"]);
      const session = await seated([await tableFixture(database(), scenario)]);

      await expect(
        assignSessionServer(database(), actor, session.id, {
          serverEmployeeId: null,
          expectedVersion: session.version,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });
});
