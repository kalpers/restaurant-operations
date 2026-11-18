import { asc, inArray, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { outboxEvents } from "@/db/schema";
import {
  addTableToSession,
  assignSessionServer,
  moveSession,
  removeTableFromSession,
} from "@/modules/restaurant/services/session-service";
import { changeTableCondition, cleanTable } from "@/modules/restaurant/services/table-service";
import { seatParty } from "@/workflows/seat-party/seat-party";
import {
  cancelTableSession,
  completeTableSession,
} from "@/workflows/end-table-session/end-table-session";

import { clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  createRestaurantScenario,
  tableFixture,
  tableRow,
  type RestaurantScenario,
} from "../../fixtures/restaurant-fixtures";

const database = () => getDatabase();

/** The floor events about these sessions and tables, oldest first. */
async function floorEvents(aggregateIds: readonly string[]) {
  return database()
    .select()
    .from(outboxEvents)
    .where(inArray(outboxEvents.aggregateId, [...aggregateIds]))
    .orderBy(asc(outboxEvents.sequence));
}

const types = (rows: { eventType: string }[]) => rows.map((row) => row.eventType);

// Phase 27 policies 2–3: floor changes tell open boards, after commit, IDs only.
describe("floor realtime events", () => {
  let scenario: RestaurantScenario;

  beforeEach(async () => {
    scenario = await createRestaurantScenario(database());
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  const seat = (tableIds: string[]) =>
    seatParty(database(), scenario.owner, { tableIds, partySize: 2, serverEmployeeId: null });

  it("writes one event per session change, with session and table IDs only", async () => {
    const first = await tableFixture(database(), scenario);
    const second = await tableFixture(database(), scenario);
    const third = await tableFixture(database(), scenario);
    const session = await seat([first]);
    let version = session.version;

    version = (await addTableToSession(database(), scenario.owner, session.id, {
      tableId: second,
      expectedVersion: version,
    })).version;
    version = (await removeTableFromSession(database(), scenario.owner, session.id, first, {
      expectedVersion: version,
    })).version;
    version = (await moveSession(database(), scenario.owner, session.id, {
      tableIds: [third],
      expectedVersion: version,
    })).version;
    version = (await assignSessionServer(database(), scenario.owner, session.id, {
      serverEmployeeId: null,
      expectedVersion: version,
    })).version;
    await completeTableSession(database(), scenario.owner, session.id, { expectedVersion: version });

    const sessionEvents = await floorEvents([session.id]);

    expect(types(sessionEvents)).toEqual([
      "table.session-opened",
      "table.session-tables-changed",
      "table.session-tables-changed",
      "table.session-moved",
      "table.session-server-assigned",
      "table.session-completed",
    ]);
    expect(sessionEvents.map((event) => (event.payload as { tableIds: string[] }).tableIds)).toEqual([
      [first],
      [first, second],
      [second],
      [third],
      [third],
      [third],
    ]);

    for (const event of sessionEvents) {
      expect(event).toMatchObject({
        aggregateType: "table_session",
        organizationId: scenario.owner.organizationId,
        locationId: scenario.owner.locationId,
        recipientUserId: null,
      });
      expect(Object.keys(event.payload as object).sort()).toEqual(["sessionId", "tableIds"]);
    }

    // Each table left behind or ended became DIRTY, and said so.
    const tableEvents = await floorEvents([first, second, third]);

    expect(types(tableEvents)).toEqual([
      "table.condition-changed",
      "table.condition-changed",
      "table.condition-changed",
    ]);
    expect(tableEvents.map((event) => event.aggregateId)).toEqual([first, second, third]);

    for (const event of tableEvents) {
      expect(event.payload).toEqual({ tableId: event.aggregateId });
    }
  });

  it("tells the floor when a table is cleaned or taken out of service", async () => {
    const table = await tableFixture(database(), scenario);
    const session = await seat([table]);

    await completeTableSession(database(), scenario.owner, session.id, { expectedVersion: session.version });
    await cleanTable(database(), scenario.owner, table, {
      expectedVersion: (await tableRow(database(), table)).version,
    });
    await changeTableCondition(database(), scenario.owner, table, {
      condition: "OUT_OF_SERVICE",
      reason: "Wobbly leg",
      expectedVersion: (await tableRow(database(), table)).version,
    });

    const events = await floorEvents([table]);

    expect(types(events)).toEqual([
      "table.condition-changed",
      "table.condition-changed",
      "table.condition-changed",
    ]);
    // The reason stays in the condition history; the event carries the ID only.
    expect(events.at(-1)!.payload).toEqual({ tableId: table });
  });

  it("writes a cancelled event for a seating made by mistake", async () => {
    const table = await tableFixture(database(), scenario);
    const session = await seat([table]);

    await cancelTableSession(database(), scenario.owner, session.id, {
      reason: "Wrong table",
      expectedVersion: session.version,
    });

    expect(types(await floorEvents([session.id]))).toEqual([
      "table.session-opened",
      "table.session-cancelled",
    ]);
    // A cancelled seating leaves the table as it was.
    expect(await floorEvents([table])).toEqual([]);
  });

  it("writes nothing when a change is refused", async () => {
    const table = await tableFixture(database(), scenario);
    const other = await tableFixture(database(), scenario);
    const session = await seat([table]);
    const before = await database()
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(like(outboxEvents.eventType, "table%"));

    await expect(
      moveSession(database(), scenario.owner, session.id, { tableIds: [other], expectedVersion: 99 }),
    ).rejects.toBeDefined();
    await expect(
      completeTableSession(database(), scenario.owner, session.id, { expectedVersion: 99 }),
    ).rejects.toBeDefined();
    await expect(seat([table])).rejects.toMatchObject({ code: "TABLE_ALREADY_OCCUPIED" });
    await expect(
      cleanTable(database(), scenario.owner, other, {
        expectedVersion: (await tableRow(database(), other)).version,
      }),
    ).rejects.toMatchObject({ code: "TABLE_NOT_DIRTY" });

    const after = await database()
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(like(outboxEvents.eventType, "table%"));

    expect(after).toHaveLength(before.length);
  });
});
