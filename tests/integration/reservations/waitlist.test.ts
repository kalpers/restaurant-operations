import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { tableSessions } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import {
  recommendTablesFor,
  suggestWaitQuote,
} from "@/modules/reservations/services/recommendation-service";
import {
  checkInReservation,
  getReservation,
} from "@/modules/reservations/services/reservation-service";
import {
  addToWaitlist,
  assignWaitlistTables,
  listWaitlist,
  notifyWaitlistEntry,
  removeWaitlistEntry,
  updateWaitlistEntry,
} from "@/modules/reservations/services/waitlist-service";
import { getFloorStatus } from "@/modules/restaurant/services/floor-service";
import {
  completeTableSession,
  cancelTableSession,
} from "@/workflows/end-table-session/end-table-session";
import { seatWaitlistParty } from "@/workflows/seat-guest-party/seat-guest-party";

import { clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  partyHistory,
  partyRow,
  reservationHost,
  reservationManager,
  reservationRow,
  reserve,
  waitlistPlannedRows,
  waitlistRow,
} from "../../fixtures/reservation-fixtures";
import {
  createRestaurantScenario,
  tableFixture,
  type RestaurantScenario,
} from "../../fixtures/restaurant-fixtures";

const database = () => getDatabase();

describe("waitlist", () => {
  let scenario: RestaurantScenario;
  let host: Actor;
  let manager: Actor;

  beforeEach(async () => {
    scenario = await createRestaurantScenario(database());
    host = await reservationHost(database(), scenario);
    manager = await reservationManager(database(), scenario);
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  const add = (extra = {}) =>
    addToWaitlist(database(), host, {
      guestName: "Walk In",
      partySize: 2,
      quotedWaitMinutes: 20,
      ...extra,
    });

  it("creates a walk-in party and a waiting entry", async () => {
    const created = await add();
    const entry = await waitlistRow(database(), created.id);
    const party = await partyRow(database(), entry.guestPartyId);

    expect(entry).toMatchObject({
      status: "WAITING",
      quotedWaitMinutes: 20,
      createdByUserId: host.userId,
      version: 1,
    });
    expect(entry.addedAt).toBeInstanceOf(Date);
    expect(party).toMatchObject({ status: "WAITING", guestName: "Walk In" });
    expect(await partyHistory(database(), party.id)).toMatchObject([
      { status: "WAITING", changedByUserId: host.userId },
    ]);
  });

  it("creates no reservation and no session for a walk-in", async () => {
    await add();

    expect(
      await database()
        .select()
        .from(tableSessions)
        .where(eq(tableSessions.locationId, scenario.locationA)),
    ).toEqual([]);
  });

  it("refuses a second open entry for the same party", async () => {
    const created = await add();
    const entry = await waitlistRow(database(), created.id);

    await expect(
      addToWaitlist(database(), host, { guestPartyId: entry.guestPartyId }),
    ).rejects.toMatchObject({ code: "PARTY_NOT_WAITLISTABLE" });
  });

  it("requires a name and a size for a walk-in", async () => {
    await expect(
      addToWaitlist(database(), host, { guestName: "Only a name" }),
    ).rejects.toMatchObject({ code: "PARTY_DETAILS_REQUIRED" });
  });

  it("puts a reservation party on the waitlist without a second party", async () => {
    const reservation = await reserve(database(), host, 5);

    await checkInReservation(database(), host, reservation.id, { expectedVersion: 1 });

    const row = await reservationRow(database(), reservation.id);
    const created = await addToWaitlist(database(), host, {
      guestPartyId: row.guestPartyId,
      quotedWaitMinutes: 10,
    });
    const entry = await waitlistRow(database(), created.id);

    expect(entry.guestPartyId).toBe(row.guestPartyId);
    expect((await partyRow(database(), row.guestPartyId)).status).toBe("WAITING");
    expect((await reservationRow(database(), reservation.id)).status).toBe("CHECKED_IN");
  });

  it("edits the quote and refuses a stale version", async () => {
    const created = await add();

    await updateWaitlistEntry(database(), host, created.id, {
      expectedVersion: 1,
      quotedWaitMinutes: 45,
    });

    expect((await waitlistRow(database(), created.id)).quotedWaitMinutes).toBe(45);
    await expect(
      updateWaitlistEntry(database(), host, created.id, {
        expectedVersion: 1,
        quotedWaitMinutes: 5,
      }),
    ).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });
  });

  it("records a notification and sends nothing", async () => {
    const created = await add();

    await notifyWaitlistEntry(database(), host, created.id, { expectedVersion: 1 });

    const entry = await waitlistRow(database(), created.id);

    expect(entry).toMatchObject({ status: "NOTIFIED", notifiedByUserId: host.userId });
    expect(entry.notifiedAt).not.toBeNull();
    await expect(
      notifyWaitlistEntry(database(), host, created.id, { expectedVersion: 2 }),
    ).rejects.toMatchObject({ code: "INVALID_WAITLIST_TRANSITION" });
  });

  describe("table assignment", () => {
    it("records the host's choice and creates no occupancy", async () => {
      const table = await tableFixture(database(), scenario);
      const created = await add();

      await assignWaitlistTables(database(), host, created.id, {
        expectedVersion: 1,
        tableIds: [table],
      });

      expect((await waitlistRow(database(), created.id)).status).toBe("TABLE_ASSIGNED");
      expect(await waitlistPlannedRows(database(), created.id)).toMatchObject([
        { restaurantTableId: table, removedAt: null },
      ]);

      const floor = await getFloorStatus(database(), host);

      expect(floor.find((row) => row.id === table)).toMatchObject({
        availability: "AVAILABLE",
        session: null,
      });
    });

    it("replaces and clears the choice, keeping history, and returns to where it was", async () => {
      const first = await tableFixture(database(), scenario);
      const second = await tableFixture(database(), scenario);
      const created = await add();

      await notifyWaitlistEntry(database(), host, created.id, { expectedVersion: 1 });
      await assignWaitlistTables(database(), host, created.id, {
        expectedVersion: 2,
        tableIds: [first],
      });
      await assignWaitlistTables(database(), host, created.id, {
        expectedVersion: 3,
        tableIds: [second],
      });
      await assignWaitlistTables(database(), host, created.id, {
        expectedVersion: 4,
        tableIds: [],
      });

      expect((await waitlistRow(database(), created.id)).status).toBe("NOTIFIED");
      expect(await waitlistPlannedRows(database(), created.id)).toHaveLength(2);
      expect(
        (await waitlistPlannedRows(database(), created.id)).every((row) => row.removedAt),
      ).toBe(true);
    });

    it("refuses tables the party can't fit", async () => {
      const small = await tableFixture(database(), scenario, { capacity: 2 });
      const created = await add({ partySize: 5 });

      await expect(
        assignWaitlistTables(database(), host, created.id, {
          expectedVersion: 1,
          tableIds: [small],
        }),
      ).rejects.toMatchObject({ code: "PARTY_EXCEEDS_CAPACITY" });
    });
  });

  describe("outcomes", () => {
    it("records LEFT and cancels the walk-in party", async () => {
      const created = await add();

      await removeWaitlistEntry(database(), host, created.id, {
        expectedVersion: 1,
        outcome: "LEFT",
      });

      const entry = await waitlistRow(database(), created.id);

      expect(entry).toMatchObject({ status: "LEFT", removedByUserId: host.userId });
      expect(entry.removedAt).not.toBeNull();
      expect((await partyRow(database(), entry.guestPartyId)).status).toBe("CANCELLED");
    });

    it("records CANCELLED, and neither is reversible", async () => {
      const created = await add();

      await removeWaitlistEntry(database(), host, created.id, {
        expectedVersion: 1,
        outcome: "CANCELLED",
      });

      expect((await waitlistRow(database(), created.id)).status).toBe("CANCELLED");
      await expect(
        notifyWaitlistEntry(database(), host, created.id, { expectedVersion: 2 }),
      ).rejects.toMatchObject({ code: "WAITLIST_ENTRY_CLOSED" });
    });

    it("returns a reservation party to its reservation when it leaves the waitlist", async () => {
      const reservation = await reserve(database(), host, 5);

      await checkInReservation(database(), host, reservation.id, { expectedVersion: 1 });

      const row = await reservationRow(database(), reservation.id);
      const created = await addToWaitlist(database(), host, { guestPartyId: row.guestPartyId });

      await removeWaitlistEntry(database(), host, created.id, {
        expectedVersion: 1,
        outcome: "LEFT",
      });

      expect((await partyRow(database(), row.guestPartyId)).status).toBe("CHECKED_IN");
      expect((await reservationRow(database(), reservation.id)).status).toBe("CHECKED_IN");
    });

    it("lets the party join the waitlist again after leaving", async () => {
      const reservation = await reserve(database(), host, 5);

      await checkInReservation(database(), host, reservation.id, { expectedVersion: 1 });

      const row = await reservationRow(database(), reservation.id);
      const first = await addToWaitlist(database(), host, { guestPartyId: row.guestPartyId });

      await removeWaitlistEntry(database(), host, first.id, {
        expectedVersion: 1,
        outcome: "LEFT",
      });

      await expect(
        addToWaitlist(database(), host, { guestPartyId: row.guestPartyId }),
      ).resolves.toBeDefined();
    });
  });

  describe("seating", () => {
    it("seats a waiting party at the chosen table and links the session", async () => {
      const table = await tableFixture(database(), scenario);
      const created = await add();
      const seated = await seatWaitlistParty(database(), host, {
        entryId: created.id,
        expectedVersion: 1,
        tableIds: [table],
      });
      const entry = await waitlistRow(database(), created.id);
      const [session] = await database()
        .select()
        .from(tableSessions)
        .where(eq(tableSessions.id, seated.id));

      expect(entry.status).toBe("SEATED");
      expect(entry.seatedAt).not.toBeNull();
      expect(session!.guestPartyId).toBe(entry.guestPartyId);
      expect((await partyRow(database(), entry.guestPartyId)).status).toBe("SEATED");
      expect(
        (await getFloorStatus(database(), host)).find((row) => row.id === table),
      ).toMatchObject({ availability: "OCCUPIED" });
    });

    it("seats a notified party with table assigned, ending the planned choice", async () => {
      const table = await tableFixture(database(), scenario);
      const created = await add();

      await notifyWaitlistEntry(database(), host, created.id, { expectedVersion: 1 });
      await assignWaitlistTables(database(), host, created.id, {
        expectedVersion: 2,
        tableIds: [table],
      });
      await seatWaitlistParty(database(), host, {
        entryId: created.id,
        expectedVersion: 3,
        tableIds: [table],
      });

      expect((await waitlistPlannedRows(database(), created.id))[0]).toMatchObject({
        removalReason: "SEATED",
      });
    });

    it("never seats one entry twice, even concurrently", async () => {
      const first = await tableFixture(database(), scenario);
      const second = await tableFixture(database(), scenario);
      const created = await add();
      const results = await Promise.allSettled(
        [first, second].map((table) =>
          seatWaitlistParty(database(), host, {
            entryId: created.id,
            expectedVersion: 1,
            tableIds: [table],
          }),
        ),
      );

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(
        await database()
          .select()
          .from(tableSessions)
          .where(
            and(
              eq(tableSessions.locationId, scenario.locationA),
              eq(tableSessions.status, "ACTIVE"),
            ),
          ),
      ).toHaveLength(1);
    });

    it("leaves the entry waiting when seating is refused", async () => {
      const occupied = await tableFixture(database(), scenario);
      const other = await add({ guestName: "Other" });
      const created = await add();

      await seatWaitlistParty(database(), host, {
        entryId: other.id,
        expectedVersion: 1,
        tableIds: [occupied],
      });

      await expect(
        seatWaitlistParty(database(), host, {
          entryId: created.id,
          expectedVersion: 1,
          tableIds: [occupied],
        }),
      ).rejects.toMatchObject({ code: "TABLE_ALREADY_OCCUPIED" });
      expect(await waitlistRow(database(), created.id)).toMatchObject({
        status: "WAITING",
        version: 1,
      });
    });

    it("restores the entry when the seating is cancelled, and completes it with the visit", async () => {
      const table = await tableFixture(database(), scenario);
      const created = await add();

      await notifyWaitlistEntry(database(), host, created.id, { expectedVersion: 1 });

      const seated = await seatWaitlistParty(database(), host, {
        entryId: created.id,
        expectedVersion: 2,
        tableIds: [table],
      });

      await cancelTableSession(database(), manager, seated.id, {
        reason: "Wrong table",
        expectedVersion: seated.version,
      });

      expect(await waitlistRow(database(), created.id)).toMatchObject({
        status: "NOTIFIED",
        seatedAt: null,
      });
      expect((await partyRow(database(), seated.guestPartyId)).status).toBe("WAITING");

      const again = await seatWaitlistParty(database(), host, {
        entryId: created.id,
        expectedVersion: (await waitlistRow(database(), created.id)).version,
        tableIds: [table],
      });

      await completeTableSession(database(), host, again.id, {
        expectedVersion: again.version,
      });

      expect((await partyRow(database(), seated.guestPartyId)).status).toBe("COMPLETED");
      expect((await waitlistRow(database(), created.id)).status).toBe("SEATED");
    });

    it("seats a reservation party that was waiting, and updates both records", async () => {
      const table = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, 5);

      await checkInReservation(database(), host, reservation.id, { expectedVersion: 1 });

      const row = await reservationRow(database(), reservation.id);
      const created = await addToWaitlist(database(), host, { guestPartyId: row.guestPartyId });

      await seatWaitlistParty(database(), host, {
        entryId: created.id,
        expectedVersion: 1,
        tableIds: [table],
      });

      expect((await waitlistRow(database(), created.id)).status).toBe("SEATED");
      expect((await getReservation(database(), host, reservation.id)).status).toBe("SEATED");
    });
  });

  describe("recommendations and quotes", () => {
    it("recommends the smallest adequate table and creates no hold or occupancy", async () => {
      const big = await tableFixture(database(), scenario, { capacity: 6, tableNumber: "R-BIG" });
      const small = await tableFixture(database(), scenario, { capacity: 2, tableNumber: "R-SMALL" });
      const result = await recommendTablesFor(database(), host, { partySize: 2 });

      expect(result.recommendations[0]).toMatchObject({ tableIds: [small] });
      expect(result.recommendations.map((entry) => entry.tableIds[0])).toContain(big);

      const floor = await getFloorStatus(database(), host);

      expect(floor.find((row) => row.id === small)).toMatchObject({
        availability: "AVAILABLE",
        session: null,
      });
      expect(
        await database()
          .select()
          .from(tableSessions)
          .where(eq(tableSessions.locationId, scenario.locationA)),
      ).toEqual([]);
    });

    it("excludes a held table for an unrelated party but not for the reserving party", async () => {
      const table = await tableFixture(database(), scenario, { capacity: 4 });
      const reservation = await reserve(database(), host, 5, { tableIds: [table] });
      const own = (await reservationRow(database(), reservation.id)).guestPartyId;

      expect(
        (await recommendTablesFor(database(), host, { partySize: 2 })).excluded,
      ).toMatchObject([{ tableId: table, reason: "RESERVATION_HOLD" }]);
      expect(
        (await recommendTablesFor(database(), host, { partySize: 2, guestPartyId: own }))
          .recommendations[0],
      ).toMatchObject({ tableIds: [table] });
    });

    it("combines at most three tables from one area when no table fits", async () => {
      await Promise.all(
        [1, 2, 3, 4].map((index) =>
          tableFixture(database(), scenario, { capacity: 2, tableNumber: `C-${index}` }),
        ),
      );

      const result = await recommendTablesFor(database(), host, {
        partySize: 6,
        preferredAreaId: scenario.dining,
      });

      expect(result.recommendations[0]!.tableIds).toHaveLength(3);
      expect(result.recommendations.every((entry) => entry.tableIds.length <= 3)).toBe(true);
      expect(
        (await recommendTablesFor(database(), host, { partySize: 7 })).recommendations,
      ).toEqual([]);

      await tableFixture(database(), scenario, { areaId: scenario.bar, capacity: 8, tableNumber: "C-BAR" });

      expect(
        (await recommendTablesFor(database(), host, { partySize: 8, preferredAreaId: scenario.dining }))
          .recommendations[0]!.tableNumbers,
      ).toEqual(["C-BAR"]);
    });

    it("suggests zero when a table is free and a positive wait when none is", async () => {
      const table = await tableFixture(database(), scenario, { capacity: 2 });

      expect((await suggestWaitQuote(database(), host, { partySize: 2 })).minutes).toBe(0);

      const created = await add();

      await seatWaitlistParty(database(), host, {
        entryId: created.id,
        expectedVersion: 1,
        tableIds: [table],
      });

      const quote = await suggestWaitQuote(database(), host, { partySize: 2 });

      expect(quote.minutes).toBeGreaterThan(0);
      expect(quote.basis).toBe("EARLIEST_TABLE_TURN");
      expect(quote.turnMinutes).toBe(90);
    });

    it("lists open entries oldest first with the host's chosen tables", async () => {
      const table = await tableFixture(database(), scenario);
      const first = await add({ guestName: "First" });
      const second = await add({ guestName: "Second" });

      await assignWaitlistTables(database(), host, second.id, {
        expectedVersion: 1,
        tableIds: [table],
      });

      const entries = await listWaitlist(database(), host);

      expect(entries.map((entry) => entry.guestName)).toEqual(["First", "Second"]);
      expect(entries[1]!.assignedTables).toMatchObject([{ id: table }]);
      expect(entries[0]!.id).toBe(first.id);
    });
  });
});
