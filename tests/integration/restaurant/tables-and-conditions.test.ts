import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { restaurantAreas, restaurantTables } from "@/db/schema";
import { getFloorStatus } from "@/modules/restaurant/services/floor-service";
import { completeSession } from "@/modules/restaurant/services/session-service";
import {
  changeTableCondition,
  cleanTable,
  createTable,
  updateTable,
} from "@/modules/restaurant/services/table-service";
import { AuthorizationError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { seatParty } from "@/workflows/seat-party/seat-party";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  conditionHistory,
  createRestaurantScenario,
  tableFixture,
  tableRow,
  type RestaurantScenario,
} from "../../fixtures/restaurant-fixtures";

const database = () => getDatabase();

function tableInput(scenario: RestaurantScenario, overrides = {}) {
  return {
    restaurantAreaId: scenario.dining,
    tableNumber: `T-${randomUUID().slice(0, 8)}`,
    name: null,
    capacity: 4,
    minimumCapacity: null,
    sortOrder: null,
    ...overrides,
  };
}

describe("table configuration", () => {
  let scenario: RestaurantScenario;

  beforeEach(async () => {
    scenario = await createRestaurantScenario(database());
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  it("creates a CLEAN table and starts its condition history", async () => {
    const { id } = await createTable(database(), scenario.owner, tableInput(scenario));
    const row = await tableRow(database(), id);

    expect(row).toMatchObject({ condition: "CLEAN", active: true, version: 1 });
    expect(await conditionHistory(database(), id)).toMatchObject([
      { condition: "CLEAN", changedByUserId: scenario.owner.userId },
    ]);
  });

  it("refuses a duplicate table number at one location", async () => {
    const input = tableInput(scenario);

    await createTable(database(), scenario.owner, input);

    await expect(
      createTable(database(), scenario.owner, input),
    ).rejects.toMatchObject({ code: "TABLE_NUMBER_TAKEN" });
  });

  it("allows the same number at another location", async () => {
    const tableNumber = "SHARED-1";

    await createTable(database(), scenario.owner, tableInput(scenario, { tableNumber }));
    await expect(
      createTable(
        database(),
        scenario.ownerAtB,
        tableInput(scenario, { tableNumber, restaurantAreaId: scenario.diningAtB }),
      ),
    ).resolves.toBeDefined();
  });

  it("refuses an area at another location", async () => {
    await expect(
      createTable(
        database(),
        scenario.owner,
        tableInput(scenario, { restaurantAreaId: scenario.diningAtB }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses an area mismatch in PostgreSQL too", async () => {
    await expect(
      database().insert(restaurantTables).values({
        locationId: scenario.locationA,
        restaurantAreaId: scenario.diningAtB,
        tableNumber: "BAD",
        capacity: 2,
      }),
    ).rejects.toThrow();
  });

  it("never lets Takeout be a table", async () => {
    await expect(
      createTable(
        database(),
        scenario.owner,
        tableInput(scenario, { restaurantAreaId: scenario.takeout }),
      ),
    ).rejects.toMatchObject({ code: "TAKEOUT_HAS_NO_TABLES" });
  });

  it("enforces capacity rules in the service and in PostgreSQL", async () => {
    await expect(
      createTable(
        database(),
        scenario.owner,
        tableInput(scenario, { capacity: 2, minimumCapacity: 3 }),
      ),
    ).rejects.toMatchObject({ code: "MINIMUM_CAPACITY_TOO_HIGH" });

    for (const values of [
      { capacity: 0 },
      { capacity: -1 },
      { capacity: 2, minimumCapacity: 0 },
      { capacity: 2, minimumCapacity: 3 },
    ]) {
      await expect(
        database().insert(restaurantTables).values({
          locationId: scenario.locationA,
          restaurantAreaId: scenario.dining,
          tableNumber: randomUUID().slice(0, 8),
          ...values,
        }),
      ).rejects.toThrow();
    }
  });

  it("refuses a stale configuration edit", async () => {
    const id = await tableFixture(database(), scenario);
    const update = { ...tableInput(scenario), active: true, expectedVersion: 1 };

    await updateTable(database(), scenario.owner, id, update);

    await expect(
      updateTable(database(), scenario.owner, id, update),
    ).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it("deactivates without erasing, and an inactive table can't be seated", async () => {
    const id = await tableFixture(database(), scenario);
    const row = await tableRow(database(), id);

    await updateTable(database(), scenario.owner, id, {
      ...tableInput(scenario, { tableNumber: row.tableNumber }),
      active: false,
      expectedVersion: 1,
    });

    expect((await tableRow(database(), id)).active).toBe(false);
    await expect(
      seatParty(database(), scenario.owner, {
        tableIds: [id],
        partySize: 2,
        serverEmployeeId: null,
      }),
    ).rejects.toMatchObject({ code: "TABLE_INACTIVE" });
  });

  it("lets a party seated before its area was deactivated be completed", async () => {
    const id = await tableFixture(database(), scenario);
    const session = await seatParty(database(), scenario.owner, {
      tableIds: [id],
      partySize: 2,
      serverEmployeeId: null,
    });

    await database()
      .update(restaurantAreas)
      .set({ active: false })
      .where(eq(restaurantAreas.id, scenario.dining));

    const floor = await getFloorStatus(database(), scenario.owner);

    expect(floor.find((table) => table.id === id)?.session?.id).toBe(session.id);
    await completeSession(database(), scenario.owner, session.id, {
      expectedVersion: session.version,
    });
    expect((await tableRow(database(), id)).condition).toBe("DIRTY");
  });

  it("refuses deactivating or moving an occupied table", async () => {
    const id = await tableFixture(database(), scenario);
    const row = await tableRow(database(), id);

    await seatParty(database(), scenario.owner, {
      tableIds: [id],
      partySize: 2,
      serverEmployeeId: null,
    });

    await expect(
      updateTable(database(), scenario.owner, id, {
        ...tableInput(scenario, { tableNumber: row.tableNumber }),
        active: false,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "TABLE_ALREADY_OCCUPIED" });
    await expect(
      updateTable(database(), scenario.owner, id, {
        ...tableInput(scenario, {
          tableNumber: row.tableNumber,
          restaurantAreaId: scenario.bar,
        }),
        active: true,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "TABLE_ALREADY_OCCUPIED" });
  });

  it("derives the floor's availability and stores no combined status", async () => {
    const free = await tableFixture(database(), scenario);
    const seated = await tableFixture(database(), scenario);

    await seatParty(database(), scenario.owner, {
      tableIds: [seated],
      partySize: 2,
      serverEmployeeId: null,
    });

    const floor = await getFloorStatus(database(), scenario.owner);

    expect(floor.find((table) => table.id === free)).toMatchObject({
      condition: "CLEAN",
      availability: "AVAILABLE",
      session: null,
    });
    // Clean and occupied at once: condition and occupancy are separate facts.
    expect(floor.find((table) => table.id === seated)).toMatchObject({
      condition: "CLEAN",
      availability: "OCCUPIED",
    });
    expect((await tableRow(database(), seated)).condition).toBe("CLEAN");
    expect(Object.keys(restaurantTables)).not.toContain("status");
    expect(Object.keys(restaurantTables)).not.toContain("occupied");
  });

  it("treats a table in an inactive area as INACTIVE, and refuses seating it", async () => {
    const id = await tableFixture(database(), scenario);

    await database()
      .update(restaurantAreas)
      .set({ active: false })
      .where(eq(restaurantAreas.id, scenario.dining));

    const floor = await getFloorStatus(database(), scenario.owner);

    expect(floor.find((table) => table.id === id)?.availability).toBe("INACTIVE");
    await expect(
      seatParty(database(), scenario.owner, {
        tableIds: [id],
        partySize: 2,
        serverEmployeeId: null,
      }),
    ).rejects.toMatchObject({ code: "TABLE_INACTIVE" });
  });
});

describe("clean and condition workflows", () => {
  let scenario: RestaurantScenario;

  beforeEach(async () => {
    scenario = await createRestaurantScenario(database());
  });

  afterAll(async () => {
    await clearEmployeeData(database());
  });

  async function dirtyTable() {
    const id = await tableFixture(database(), scenario);
    const session = await seatParty(database(), scenario.owner, {
      tableIds: [id],
      partySize: 2,
      serverEmployeeId: null,
    });

    await completeSession(database(), scenario.owner, session.id, {
      expectedVersion: session.version,
    });

    return id;
  }

  it("cleans DIRTY to CLEAN and appends history", async () => {
    const id = await dirtyTable();
    const before = await tableRow(database(), id);

    await cleanTable(database(), scenario.owner, id, {
      expectedVersion: before.version,
    });

    expect((await tableRow(database(), id)).condition).toBe("CLEAN");
    expect(
      (await conditionHistory(database(), id)).map((row) => row.condition),
    ).toEqual(["CLEAN", "DIRTY", "CLEAN"]);
  });

  it("refuses a clean attempt on an occupied table", async () => {
    const id = await tableFixture(database(), scenario);

    await seatParty(database(), scenario.owner, {
      tableIds: [id],
      partySize: 2,
      serverEmployeeId: null,
    });

    await expect(
      cleanTable(database(), scenario.owner, id, { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "TABLE_ALREADY_OCCUPIED" });
  });

  it("refuses cleaning a table that isn't dirty", async () => {
    const id = await tableFixture(database(), scenario);

    await expect(
      cleanTable(database(), scenario.owner, id, { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "TABLE_NOT_DIRTY" });
  });

  it("refuses a stale clean", async () => {
    const id = await dirtyTable();

    await expect(
      cleanTable(database(), scenario.owner, id, { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it("blocks seating while dirty, and allows it once clean", async () => {
    const id = await dirtyTable();
    const seat = () =>
      seatParty(database(), scenario.owner, {
        tableIds: [id],
        partySize: 2,
        serverEmployeeId: null,
      });

    await expect(seat()).rejects.toMatchObject({ code: "TABLE_DIRTY" });

    await cleanTable(database(), scenario.owner, id, {
      expectedVersion: (await tableRow(database(), id)).version,
    });

    await expect(seat()).resolves.toBeDefined();
  });

  it("takes a table out of service and back with an explicit target", async () => {
    const id = await tableFixture(database(), scenario);
    const seat = () =>
      seatParty(database(), scenario.owner, {
        tableIds: [id],
        partySize: 2,
        serverEmployeeId: null,
      });

    await changeTableCondition(database(), scenario.owner, id, {
      condition: "OUT_OF_SERVICE",
      reason: "Wobbly leg",
      expectedVersion: 1,
    });
    await expect(seat()).rejects.toMatchObject({ code: "TABLE_OUT_OF_SERVICE" });

    await changeTableCondition(database(), scenario.owner, id, {
      condition: "CLEAN",
      reason: "Fixed",
      expectedVersion: 2,
    });
    await expect(seat()).resolves.toBeDefined();
    expect(await conditionHistory(database(), id)).toMatchObject([
      { condition: "CLEAN" },
      { condition: "OUT_OF_SERVICE", reason: "Wobbly leg" },
      { condition: "CLEAN", reason: "Fixed" },
    ]);
  });

  it("refuses a condition change on an occupied table", async () => {
    const id = await tableFixture(database(), scenario);

    await seatParty(database(), scenario.owner, {
      tableIds: [id],
      partySize: 2,
      serverEmployeeId: null,
    });

    await expect(
      changeTableCondition(database(), scenario.owner, id, {
        condition: "OUT_OF_SERVICE",
        reason: null,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "TABLE_ALREADY_OCCUPIED" });
  });

  it("denies a condition change and a clean without the permission", async () => {
    const id = await dirtyTable();
    const version = (await tableRow(database(), id)).version;
    const actor = await actorWith(database(), scenario, ["restaurant.view"]);

    await expect(
      changeTableCondition(database(), actor, id, {
        condition: "OUT_OF_SERVICE",
        reason: null,
        expectedVersion: version,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      cleanTable(database(), actor, id, { expectedVersion: version }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

});
