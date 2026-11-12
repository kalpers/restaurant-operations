import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { tableSessions, tableSessionTables } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { listTableHoldIndicators } from "@/modules/reservations/services/hold-service";
import {
  cancelReservation,
  checkInReservation,
  getReservation,
} from "@/modules/reservations/services/reservation-service";
import { getFloorStatus } from "@/modules/restaurant/services/floor-service";
import { changeTableCondition } from "@/modules/restaurant/services/table-service";
import {
  cancelTableSession,
  completeTableSession,
} from "@/workflows/end-table-session/end-table-session";
import {
  seatReservationParty,
  seatWalkIn,
} from "@/workflows/seat-guest-party/seat-guest-party";
import {
  combineTableIntoSession,
  moveTableSession,
} from "@/workflows/move-table-session/move-table-session";
import { seatParty } from "@/workflows/seat-party/seat-party";

import { clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  holdOverrideRows,
  partyHistory,
  partyRow,
  plannedRows,
  reservationHost,
  reservationManager,
  reservationRow,
  reserve,
} from "../../fixtures/reservation-fixtures";
import {
  createRestaurantScenario,
  sessionMemberships,
  sessionRow,
  tableFixture,
  tableRow,
  type RestaurantScenario,
} from "../../fixtures/restaurant-fixtures";

const database = () => getDatabase();

describe("reservation holds and seating", () => {
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

  const walkIn = (actor: Actor, tableIds: string[], extra = {}) =>
    seatWalkIn(database(), actor, {
      guestName: "Walk In",
      partySize: 2,
      tableIds,
      ...extra,
    });

  const floorRow = async (tableId: string) =>
    (await getFloorStatus(database(), host)).find((row) => row.id === tableId)!;

  describe("a hold is not occupancy", () => {
    it("leaves a held table physically available and shows it as an indicator", async () => {
      const table = await tableFixture(database(), scenario);

      await reserve(database(), host, 5, { tableIds: [table] });

      expect(await floorRow(table)).toMatchObject({
        availability: "AVAILABLE",
        condition: "CLEAN",
        session: null,
      });
      expect(
        await database()
          .select()
          .from(tableSessionTables)
          .where(eq(tableSessionTables.restaurantTableId, table)),
      ).toEqual([]);

      const indicators = await listTableHoldIndicators(database(), host);

      expect(indicators).toMatchObject([{ tableId: table, active: true }]);
    });

    it("shows an upcoming reservation without an active hold", async () => {
      const table = await tableFixture(database(), scenario);

      await reserve(database(), host, 90, { tableIds: [table] });

      expect(await listTableHoldIndicators(database(), host)).toMatchObject([
        { tableId: table, active: false },
      ]);
    });
  });

  describe("walk-in seating against a hold", () => {
    it("blocks an ordinary host from seating an unrelated walk-in at a held table", async () => {
      const table = await tableFixture(database(), scenario);

      await reserve(database(), host, 5, { tableIds: [table] });

      await expect(walkIn(host, [table])).rejects.toMatchObject({
        code: "RESERVATION_HOLD_ACTIVE",
      });
      await expect(
        seatParty(database(), host, { tableIds: [table], partySize: 2 }),
      ).rejects.toMatchObject({ code: "RESERVATION_HOLD_ACTIVE" });
      expect((await floorRow(table)).session).toBeNull();
    });

    it("doesn't block a table whose reservation is outside the hold window", async () => {
      const table = await tableFixture(database(), scenario);

      await reserve(database(), host, 90, { tableIds: [table] });

      await expect(walkIn(host, [table])).resolves.toBeDefined();
    });

    it("lets a manager override with permission and a reason, and records provenance", async () => {
      const table = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, 5, { tableIds: [table] });
      const seated = await walkIn(manager, [table], {
        holdOverrideReason: "Regular needs the table now",
      });
      const [override] = await holdOverrideRows(database(), reservation.id);

      expect(override).toMatchObject({
        reservationId: reservation.id,
        tableSessionId: seated.id,
        restaurantTableId: table,
        category: "RESERVATION_HOLD_OVERRIDE",
        reason: "Regular needs the table now",
        overriddenByUserId: manager.userId,
      });
      expect(override!.occurredAt).toBeInstanceOf(Date);
    });

    it("doesn't cancel the reservation or its planned table when overridden", async () => {
      const table = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, 5, { tableIds: [table] });

      await walkIn(manager, [table], { holdOverrideReason: "Needed" });

      expect(await reservationRow(database(), reservation.id)).toMatchObject({
        status: "CONFIRMED",
      });
      expect(await plannedRows(database(), reservation.id)).toMatchObject([
        { removedAt: null },
      ]);
    });

    it("requires a reason even for a manager", async () => {
      const table = await tableFixture(database(), scenario);

      await reserve(database(), host, 5, { tableIds: [table] });

      await expect(walkIn(manager, [table])).rejects.toMatchObject({
        code: "RESERVATION_HOLD_ACTIVE",
      });
      await expect(
        walkIn(manager, [table], { holdOverrideReason: "   " }),
      ).rejects.toMatchObject({ code: "RESERVATION_HOLD_ACTIVE" });
    });

    it("refuses a reason from someone without the override permission", async () => {
      const table = await tableFixture(database(), scenario);

      await reserve(database(), host, 5, { tableIds: [table] });

      await expect(
        walkIn(host, [table], { holdOverrideReason: "Please" }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    it("doesn't bypass a dirty table", async () => {
      const table = await tableFixture(database(), scenario);

      await reserve(database(), host, 5, { tableIds: [table] });
      await changeTableCondition(database(), scenario.owner, table, {
        condition: "DIRTY",
        reason: "Spill",
        expectedVersion: 1,
      });

      await expect(
        walkIn(manager, [table], { holdOverrideReason: "Needed" }),
      ).rejects.toMatchObject({ code: "TABLE_DIRTY" });
    });

    it("doesn't bypass an occupied table", async () => {
      const table = await tableFixture(database(), scenario);

      await walkIn(host, [table]);
      await reserve(database(), host, 5, { tableIds: [table] }).catch(() => null);

      await expect(
        walkIn(manager, [table], { holdOverrideReason: "Needed" }),
      ).rejects.toMatchObject({ code: "TABLE_ALREADY_OCCUPIED" });
    });

    it("doesn't bypass capacity", async () => {
      const table = await tableFixture(database(), scenario, { capacity: 2 });

      await reserve(database(), host, 5, { tableIds: [table] });

      await expect(
        walkIn(manager, [table], { partySize: 6, holdOverrideReason: "Needed" }),
      ).rejects.toMatchObject({ code: "CAPACITY_OVERRIDE_REASON_REQUIRED" });
    });

    it("releases the hold when the reservation is cancelled", async () => {
      const table = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, 5, { tableIds: [table] });

      await cancelReservation(database(), host, reservation.id, { expectedVersion: 1 });

      await expect(walkIn(host, [table])).resolves.toBeDefined();
    });

    it("lets the reservation's own party take the held table", async () => {
      const table = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, 5, { tableIds: [table] });

      await expect(
        seatReservationParty(database(), host, {
          reservationId: reservation.id,
          expectedVersion: 1,
          tableIds: [table],
        }),
      ).resolves.toBeDefined();
      expect(await holdOverrideRows(database(), reservation.id)).toEqual([]);
    });
  });

  describe("seating a reservation", () => {
    it("keeps the planned table when the party sits elsewhere", async () => {
      const planned = await tableFixture(database(), scenario, { capacity: 4 });
      const second = await tableFixture(database(), scenario, { capacity: 2 });
      const third = await tableFixture(database(), scenario, { capacity: 2 });
      const reservation = await reserve(database(), host, 5, {
        partySize: 4,
        tableIds: [planned],
      });

      await checkInReservation(database(), host, reservation.id, { expectedVersion: 1 });
      await walkIn(manager, [planned], { holdOverrideReason: "Held for someone else" });

      const seated = await seatReservationParty(database(), host, {
        reservationId: reservation.id,
        expectedVersion: 2,
        tableIds: [second, third],
      });
      const view = await getReservation(database(), host, reservation.id);

      expect(view.status).toBe("SEATED");
      expect(view.plannedTables).toEqual([]);
      expect(view.planningHistory).toMatchObject([
        { tableNumber: expect.any(String), removalReason: "SEATED" },
      ]);
      expect(
        (await plannedRows(database(), reservation.id)).map((row) => row.restaurantTableId),
      ).toEqual([planned]);
      expect(view.actualSeating).toMatchObject({
        sessionId: seated.id,
        sessionStatus: "ACTIVE",
      });
      expect(view.actualSeating!.tables.map((table) => table.id).sort()).toEqual(
        [second, third].sort(),
      );
      expect((await sessionRow(database(), seated.id)).guestPartyId).toBe(seated.guestPartyId);
      expect(await partyRow(database(), seated.guestPartyId)).toMatchObject({
        status: "SEATED",
      });
      expect((await partyHistory(database(), seated.guestPartyId)).map((row) => row.status)).toEqual([
        "EXPECTED",
        "CHECKED_IN",
        "SEATED",
      ]);
    });

    it("seats a confirmed reservation without a separate check-in and records the arrival", async () => {
      const table = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, 5);

      await seatReservationParty(database(), host, {
        reservationId: reservation.id,
        expectedVersion: 1,
        tableIds: [table],
      });

      const row = await reservationRow(database(), reservation.id);

      expect(row.status).toBe("SEATED");
      expect(row.checkedInAt).not.toBeNull();
    });

    it("won't seat a pending reservation and leaves nothing behind", async () => {
      const table = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, 5, { status: "PENDING" });

      await expect(
        seatReservationParty(database(), host, {
          reservationId: reservation.id,
          expectedVersion: 1,
          tableIds: [table],
        }),
      ).rejects.toMatchObject({ code: "RESERVATION_NOT_CONFIRMED" });
      expect((await floorRow(table)).session).toBeNull();
    });

    it("refuses a stale version", async () => {
      const table = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, 5);

      await checkInReservation(database(), host, reservation.id, { expectedVersion: 1 });

      await expect(
        seatReservationParty(database(), host, {
          reservationId: reservation.id,
          expectedVersion: 1,
          tableIds: [table],
        }),
      ).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });
    });

    it("changes nothing when a Phase 5 rule refuses the seating", async () => {
      const dirty = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, 5);

      await changeTableCondition(database(), scenario.owner, dirty, {
        condition: "DIRTY",
        reason: "Spill",
        expectedVersion: 1,
      });

      await expect(
        seatReservationParty(database(), host, {
          reservationId: reservation.id,
          expectedVersion: 1,
          tableIds: [dirty],
        }),
      ).rejects.toMatchObject({ code: "TABLE_DIRTY" });

      const row = await reservationRow(database(), reservation.id);

      expect(row).toMatchObject({ status: "CONFIRMED", version: 1 });
      expect((await partyRow(database(), row.guestPartyId)).status).toBe("EXPECTED");
      expect(
        await database()
          .select()
          .from(tableSessions)
          .where(eq(tableSessions.guestPartyId, row.guestPartyId)),
      ).toEqual([]);
    });

    it("makes a reserved table occupied only once the session exists", async () => {
      const table = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, 5, { tableIds: [table] });

      expect((await floorRow(table)).availability).toBe("AVAILABLE");

      await seatReservationParty(database(), host, {
        reservationId: reservation.id,
        expectedVersion: 1,
        tableIds: [table],
      });

      expect((await floorRow(table)).availability).toBe("OCCUPIED");
    });
  });

  describe("concurrent seating", () => {
    it("creates one session when the same reservation is seated twice at once", async () => {
      const first = await tableFixture(database(), scenario);
      const second = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, 5);
      const results = await Promise.allSettled(
        [first, second].map((table) =>
          seatReservationParty(database(), host, {
            reservationId: reservation.id,
            expectedVersion: 1,
            tableIds: [table],
          }),
        ),
      );
      const row = await reservationRow(database(), reservation.id);
      const sessions = await database()
        .select()
        .from(tableSessions)
        .where(
          and(
            eq(tableSessions.guestPartyId, row.guestPartyId),
            eq(tableSessions.status, "ACTIVE"),
          ),
        );

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(sessions).toHaveLength(1);
      expect(row.status).toBe("SEATED");
    });

    it("keeps the Phase 5 table race guarantee between two parties", async () => {
      const table = await tableFixture(database(), scenario);
      const one = await reserve(database(), host, 120);
      const two = await reserve(database(), host, 130);
      const results = await Promise.allSettled(
        [one, two].map((reservation) =>
          seatReservationParty(database(), host, {
            reservationId: reservation.id,
            expectedVersion: 1,
            tableIds: [table],
          }),
        ),
      );

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(
        (
          await database()
            .select()
            .from(tableSessionTables)
            .where(eq(tableSessionTables.restaurantTableId, table))
        ).filter((row) => row.leftAt === null),
      ).toHaveLength(1);
    });

    it("lets the database refuse a second active session for one party", async () => {
      const first = await tableFixture(database(), scenario);
      const second = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, 5);
      const seated = await seatReservationParty(database(), host, {
        reservationId: reservation.id,
        expectedVersion: 1,
        tableIds: [first],
      });

      // Bypassing every service, the unique index is the last line of defence.
      await expect(
        database().execute(sql`
          INSERT INTO table_sessions (location_id, guest_party_id, party_size, created_by_user_id)
          VALUES (${scenario.locationA}, ${seated.guestPartyId}, 2, ${host.userId})
        `),
      ).rejects.toMatchObject({
        cause: { constraint_name: "table_sessions_one_active_per_guest_party_unique" },
      });

      // And through the seating service it surfaces as a clear conflict.
      await expect(
        seatParty(database(), host, {
          tableIds: [second],
          partySize: 2,
          guestPartyId: seated.guestPartyId,
        }),
      ).rejects.toMatchObject({ code: "PARTY_ALREADY_SEATED" });
    });

    it("allows a party a new session once its earlier one has ended", async () => {
      const table = await tableFixture(database(), scenario);
      const seated = await walkIn(host, [table]);
      const session = await sessionRow(database(), seated.id);

      await completeTableSession(database(), host, seated.id, {
        expectedVersion: session.version,
      });

      expect((await partyRow(database(), seated.guestPartyId)).status).toBe("COMPLETED");
    });
  });

  describe("ending a seated session", () => {
    it("completes the party and reservation with the session, and dirties the tables", async () => {
      const planned = await tableFixture(database(), scenario);
      const used = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, 5, { tableIds: [planned] });
      const seated = await seatReservationParty(database(), host, {
        reservationId: reservation.id,
        expectedVersion: 1,
        tableIds: [used],
      });

      await completeTableSession(database(), host, seated.id, {
        expectedVersion: seated.version,
      });

      const row = await reservationRow(database(), reservation.id);

      expect(row.status).toBe("COMPLETED");
      expect(await partyRow(database(), row.guestPartyId)).toMatchObject({ status: "COMPLETED" });
      expect((await partyHistory(database(), row.guestPartyId)).at(-1)!.status).toBe("COMPLETED");
      expect((await tableRow(database(), used)).condition).toBe("DIRTY");
      expect((await sessionRow(database(), seated.id)).status).toBe("COMPLETED");
      expect(await sessionMemberships(database(), seated.id)).toMatchObject([
        { restaurantTableId: used },
      ]);
      expect((await getReservation(database(), host, reservation.id)).actualSeating).toMatchObject({
        sessionStatus: "COMPLETED",
      });
    });

    it("can't be undone by cancelling or marking a seated reservation as a no-show", async () => {
      const table = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, -20);

      await seatReservationParty(database(), host, {
        reservationId: reservation.id,
        expectedVersion: 1,
        tableIds: [table],
      });

      const { markReservationNoShow } = await import(
        "@/modules/reservations/services/reservation-service"
      );

      await expect(
        cancelReservation(database(), host, reservation.id, { expectedVersion: 2 }),
      ).rejects.toMatchObject({ code: "INVALID_RESERVATION_TRANSITION" });
      await expect(
        markReservationNoShow(database(), host, reservation.id, { expectedVersion: 2 }),
      ).rejects.toMatchObject({ code: "NO_SHOW_REQUIRES_CONFIRMED" });
      expect((await floorRow(table)).availability).toBe("OCCUPIED");
    });

    it("returns the party to checked in when the seating is cancelled as a mistake", async () => {
      const table = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, 5);
      const seated = await seatReservationParty(database(), host, {
        reservationId: reservation.id,
        expectedVersion: 1,
        tableIds: [table],
      });

      await cancelTableSession(database(), manager, seated.id, {
        reason: "Wrong table",
        expectedVersion: seated.version,
      });

      const row = await reservationRow(database(), reservation.id);

      expect(row.status).toBe("CHECKED_IN");
      expect((await partyRow(database(), row.guestPartyId)).status).toBe("CHECKED_IN");
      expect((await floorRow(table)).availability).toBe("AVAILABLE");

      // It can be seated again, because the cancelled session no longer counts.
      await expect(
        seatReservationParty(database(), host, {
          reservationId: reservation.id,
          expectedVersion: row.version,
          tableIds: [table],
        }),
      ).resolves.toBeDefined();
    });
  });
  // Phase 20 (policy 8, D7): moving or combining onto a held table follows the seating rule.
  describe("moving and combining onto a held table", () => {
    it("refuses a move onto another party's held table, and allows it with an override", async () => {
      const from = await tableFixture(database(), scenario);
      const held = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, 5, { tableIds: [held] });
      const seated = await walkIn(host, [from]);

      await expect(
        moveTableSession(database(), host, seated.id, { tableIds: [held], expectedVersion: seated.version }),
      ).rejects.toMatchObject({ code: "RESERVATION_HOLD_ACTIVE" });
      await expect(
        moveTableSession(database(), host, seated.id, {
          tableIds: [held],
          holdOverrideReason: "Please",
          expectedVersion: seated.version,
        }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

      await moveTableSession(database(), manager, seated.id, {
        tableIds: [held],
        holdOverrideReason: "Party asked for the window",
        expectedVersion: seated.version,
      });

      expect(await holdOverrideRows(database(), reservation.id)).toMatchObject([
        { tableSessionId: seated.id, restaurantTableId: held, reason: "Party asked for the window" },
      ]);
    });

    it("refuses combining a held table without an override", async () => {
      const from = await tableFixture(database(), scenario);
      const held = await tableFixture(database(), scenario);

      await reserve(database(), host, 5, { tableIds: [held] });

      const seated = await walkIn(host, [from]);

      await expect(
        combineTableIntoSession(database(), host, seated.id, { tableId: held, expectedVersion: seated.version }),
      ).rejects.toMatchObject({ code: "RESERVATION_HOLD_ACTIVE" });
      expect((await sessionMemberships(database(), seated.id)).filter((row) => row.leftAt === null)).toHaveLength(1);
    });

    it("lets the reservation's own party move onto its held table", async () => {
      const held = await tableFixture(database(), scenario);
      const other = await tableFixture(database(), scenario);
      const reservation = await reserve(database(), host, 5, { tableIds: [held] });

      await checkInReservation(database(), host, reservation.id, { expectedVersion: 1 });

      const seated = await seatReservationParty(database(), host, {
        reservationId: reservation.id,
        expectedVersion: 2,
        tableIds: [other],
      });

      await expect(
        moveTableSession(database(), host, seated.id, { tableIds: [held], expectedVersion: seated.version }),
      ).resolves.toBeDefined();
    });
  });
});
