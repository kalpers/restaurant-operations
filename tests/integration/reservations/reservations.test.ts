import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  cancelReservation,
  checkInReservation,
  confirmReservation,
  getReservation,
  listReservations,
  markReservationNoShow,
  previewPlanningConflicts,
  setPlannedTables,
  updateReservation,
} from "@/modules/reservations/services/reservation-service";

import { clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  localAt,
  partyHistory,
  partyRow,
  plannedRows,
  reservationHost,
  reservationRow,
  reserve,
  setHoldWindows,
} from "../../fixtures/reservation-fixtures";
import {
  createRestaurantScenario,
  tableFixture,
  type RestaurantScenario,
} from "../../fixtures/restaurant-fixtures";
import type { Actor } from "@/modules/auth/types";

const database = () => getDatabase();

describe("reservations", () => {
  let scenario: RestaurantScenario;
  let host: Actor;

  beforeEach(async () => {
    scenario = await createRestaurantScenario(database());
    host = await reservationHost(database(), scenario);
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  describe("creation", () => {
    it("creates a confirmed reservation and an expected party with no planned table", async () => {
      const created = await reserve(database(), host, 180, { partySize: 5 });
      const reservation = await reservationRow(database(), created.id);
      const party = await partyRow(database(), reservation.guestPartyId);

      expect(reservation).toMatchObject({
        status: "CONFIRMED",
        source: "PHONE",
        expectedDurationMinutes: 60,
        version: 1,
        createdByUserId: host.userId,
      });
      expect(party).toMatchObject({ status: "EXPECTED", partySize: 5 });
      expect(await plannedRows(database(), created.id)).toEqual([]);
      expect(await partyHistory(database(), party.id)).toMatchObject([
        { status: "EXPECTED", changedByUserId: host.userId },
      ]);
    });

    it("converts the local date and time using the location's time zone", async () => {
      const when = localAt(300);
      const created = await reserve(database(), host, 300);
      const view = await getReservation(database(), host, created.id);

      // Detroit is behind UTC, so the stored instant is the typed time plus its offset.
      const local = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Detroit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(view.reservationAt));

      expect(local).toBe(when.localTime);
    });

    it("takes the default duration from the location setting", async () => {
      const created = await reserve(database(), host, 180, {
        expectedDurationMinutes: null,
      });

      expect((await reservationRow(database(), created.id)).expectedDurationMinutes).toBe(90);
    });

    it("can be created as pending, and only a confirmation makes it confirmed", async () => {
      const created = await reserve(database(), host, 180, { status: "PENDING" });

      await expect(
        checkInReservation(database(), host, created.id, { expectedVersion: 1 }),
      ).rejects.toMatchObject({ code: "INVALID_RESERVATION_TRANSITION" });

      const confirmed = await confirmReservation(database(), host, created.id, {
        expectedVersion: 1,
      });

      expect((await reservationRow(database(), created.id)).status).toBe("CONFIRMED");
      expect(confirmed.version).toBe(2);
    });

    it("plans a table, and a single table's capacity must seat the party", async () => {
      const small = await tableFixture(database(), scenario, { capacity: 2 });
      const created = await reserve(database(), host, 180, {
        partySize: 2,
        tableIds: [small],
      });

      expect(await plannedRows(database(), created.id)).toMatchObject([
        { restaurantTableId: small, removedAt: null },
      ]);
      await expect(
        reserve(database(), host, 600, { partySize: 3, tableIds: [small] }),
      ).rejects.toMatchObject({ code: "PARTY_EXCEEDS_CAPACITY" });
    });

    it("plans combined tables by their combined capacity", async () => {
      const first = await tableFixture(database(), scenario, { capacity: 2 });
      const second = await tableFixture(database(), scenario, { capacity: 4 });
      const created = await reserve(database(), host, 180, {
        partySize: 6,
        tableIds: [first, second],
      });

      expect(await plannedRows(database(), created.id)).toHaveLength(2);
    });

    it("refuses more than three tables and tables in different areas", async () => {
      const four = await Promise.all(
        [1, 2, 3, 4].map(() => tableFixture(database(), scenario, { capacity: 2 })),
      );
      const bar = await tableFixture(database(), scenario, {
        areaId: scenario.bar,
        capacity: 2,
      });
      const dining = await tableFixture(database(), scenario, { capacity: 2 });

      await expect(
        reserve(database(), host, 180, { partySize: 8, tableIds: four }),
      ).rejects.toMatchObject({ code: "TOO_MANY_TABLES" });
      await expect(
        reserve(database(), host, 180, { partySize: 4, tableIds: [bar, dining] }),
      ).rejects.toMatchObject({ code: "TABLES_IN_DIFFERENT_AREAS" });
    });

    it("refuses a table at another location, however it is named", async () => {
      const { createTable } = await import("@/modules/restaurant/services/table-service");
      const { id: tableAtB } = await createTable(database(), scenario.ownerAtB, {
        restaurantAreaId: scenario.diningAtB,
        tableNumber: "B-ONLY",
        name: null,
        capacity: 4,
        minimumCapacity: null,
        sortOrder: null,
      });

      await expect(
        reserve(database(), host, 180, { tableIds: [tableAtB] }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("rolls back everything when planning fails", async () => {
      const small = await tableFixture(database(), scenario, { capacity: 2 });
      const before = await listReservations(database(), host, {
        fromBusinessDate: "2000-01-01",
        toBusinessDate: "2100-01-01",
      });

      await expect(
        reserve(database(), host, 180, { partySize: 9, tableIds: [small] }),
      ).rejects.toMatchObject({ code: "PARTY_EXCEEDS_CAPACITY" });

      expect(
        await listReservations(database(), host, {
          fromBusinessDate: "2000-01-01",
          toBusinessDate: "2100-01-01",
        }),
      ).toHaveLength(before.length);
    });
  });

  describe("planning conflicts", () => {
    it("rejects an overlapping reservation on the same table", async () => {
      const table = await tableFixture(database(), scenario);

      await reserve(database(), host, 300, { tableIds: [table] });

      await expect(
        reserve(database(), host, 330, { tableIds: [table] }),
      ).rejects.toMatchObject({ code: "PLANNING_CONFLICT" });
    });

    it("allows a reservation whose interval only touches the other's", async () => {
      const table = await tableFixture(database(), scenario);

      // First: [t-15, t+60+15). The next may start its pre-hold exactly at t+75.
      await reserve(database(), host, 300, { tableIds: [table] });
      await expect(
        reserve(database(), host, 300 + 75 + 15, { tableIds: [table] }),
      ).resolves.toBeDefined();
      await expect(
        reserve(database(), host, 300 + 75 + 14, { tableIds: [table] }),
      ).rejects.toMatchObject({ code: "PLANNING_CONFLICT" });
    });

    it("uses the configured hold windows", async () => {
      const table = await tableFixture(database(), scenario);

      await setHoldWindows(database(), scenario.locationA, {
        preHold: 0,
        postGrace: 0,
      });
      await reserve(database(), host, 300, { tableIds: [table] });
      await expect(
        reserve(database(), host, 360, { tableIds: [table] }),
      ).resolves.toBeDefined();
    });

    it("checks each table of a combination", async () => {
      const first = await tableFixture(database(), scenario, { capacity: 2 });
      const second = await tableFixture(database(), scenario, { capacity: 2 });

      await reserve(database(), host, 300, { tableIds: [second] });

      await expect(
        reserve(database(), host, 300, { partySize: 4, tableIds: [first, second] }),
      ).rejects.toMatchObject({ code: "PLANNING_CONFLICT" });
    });

    it("lets cancelled and no-show reservations stop blocking", async () => {
      const table = await tableFixture(database(), scenario);
      const first = await reserve(database(), host, 300, { tableIds: [table] });

      await cancelReservation(database(), host, first.id, { expectedVersion: 1 });

      await expect(
        reserve(database(), host, 300, { tableIds: [table] }),
      ).resolves.toBeDefined();
    });

    it("counts pending reservations as blocking", async () => {
      const table = await tableFixture(database(), scenario);

      await reserve(database(), host, 300, { tableIds: [table], status: "PENDING" });

      await expect(
        reserve(database(), host, 300, { tableIds: [table] }),
      ).rejects.toMatchObject({ code: "PLANNING_CONFLICT" });
    });

    it("ignores a reservation whose window has already ended", async () => {
      const table = await tableFixture(database(), scenario);

      await reserve(database(), host, -300, { tableIds: [table] });

      await expect(
        reserve(database(), host, -299, { tableIds: [table] }),
      ).resolves.toBeDefined();
    });

    it("explains a conflict without exposing contact data", async () => {
      const table = await tableFixture(database(), scenario);

      await reserve(database(), host, 300, {
        tableIds: [table],
        guestName: "Pat Smith",
        phone: "555-0100",
        email: "pat@example.test",
        partySize: 3,
      });

      const preview = await previewPlanningConflicts(database(), host, {
        tableIds: [table],
        ...localAt(310),
        expectedDurationMinutes: 60,
        partySize: 2,
      });

      expect(preview.conflicts).toHaveLength(1);
      expect(preview.conflicts[0]).toMatchObject({
        tableId: table,
        guestName: "Pat Smith",
        partySize: 3,
      });
      expect(JSON.stringify(preview)).not.toContain("555-0100");
      expect(JSON.stringify(preview)).not.toContain("pat@example.test");
      expect(preview.sufficient).toBe(true);
    });

    it("reports a party the tables can't seat", async () => {
      const table = await tableFixture(database(), scenario, { capacity: 2 });
      const preview = await previewPlanningConflicts(database(), host, {
        tableIds: [table],
        ...localAt(600),
        expectedDurationMinutes: 60,
        partySize: 6,
      });

      expect(preview).toMatchObject({ capacity: 2, sufficient: false });
    });
  });

  describe("modification", () => {
    it("changes the time, party and contact details and bumps the version", async () => {
      const created = await reserve(database(), host, 180);
      const updated = await updateReservation(database(), host, created.id, {
        expectedVersion: 1,
        guestName: "Renamed",
        partySize: 4,
        phone: "555-0111",
        email: null,
        specialRequests: "Window",
        ...localAt(240),
        expectedDurationMinutes: 120,
        notes: "Birthday",
      });
      const view = await getReservation(database(), host, created.id);

      expect(updated.version).toBe(2);
      expect(view).toMatchObject({
        guestName: "Renamed",
        partySize: 4,
        phone: "555-0111",
        hasSpecialRequests: true,
        expectedDurationMinutes: 120,
        notes: "Birthday",
      });
    });

    it("refuses a stale version", async () => {
      const created = await reserve(database(), host, 180);

      await confirmReservation(
        database(),
        host,
        (await reserve(database(), host, 200, { status: "PENDING" })).id,
        { expectedVersion: 1 },
      );

      await updateReservation(database(), host, created.id, {
        expectedVersion: 1,
        guestName: "First",
        partySize: 2,
        ...localAt(180),
        expectedDurationMinutes: 60,
      });

      await expect(
        updateReservation(database(), host, created.id, {
          expectedVersion: 1,
          guestName: "Stale",
          partySize: 2,
          ...localAt(180),
          expectedDurationMinutes: 60,
        }),
      ).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });
    });

    it("revalidates capacity and conflicts when the party or time changes", async () => {
      const table = await tableFixture(database(), scenario, { capacity: 4 });
      const other = await tableFixture(database(), scenario, { capacity: 4 });
      const first = await reserve(database(), host, 300, { partySize: 4, tableIds: [table] });

      await reserve(database(), host, 600, { tableIds: [table] });

      await expect(
        updateReservation(database(), host, first.id, {
          expectedVersion: 1,
          guestName: "Test Guest",
          partySize: 6,
          ...localAt(300),
          expectedDurationMinutes: 60,
        }),
      ).rejects.toMatchObject({ code: "PARTY_EXCEEDS_CAPACITY" });
      await expect(
        updateReservation(database(), host, first.id, {
          expectedVersion: 1,
          guestName: "Test Guest",
          partySize: 4,
          ...localAt(600),
          expectedDurationMinutes: 60,
        }),
      ).rejects.toMatchObject({ code: "PLANNING_CONFLICT" });
      await expect(
        updateReservation(database(), host, first.id, {
          expectedVersion: 1,
          guestName: "Test Guest",
          partySize: 4,
          ...localAt(300),
          expectedDurationMinutes: 60,
          tableIds: [other],
        }),
      ).resolves.toBeDefined();
    });

    it("replaces planned tables and keeps the replaced one as history", async () => {
      const first = await tableFixture(database(), scenario);
      const second = await tableFixture(database(), scenario);
      const created = await reserve(database(), host, 300, { tableIds: [first] });

      await setPlannedTables(database(), host, created.id, {
        expectedVersion: 1,
        tableIds: [second],
      });

      const rows = await plannedRows(database(), created.id);

      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.restaurantTableId === first)).toMatchObject({
        removalReason: "REPLACED",
        removedByUserId: host.userId,
      });
      expect(rows.find((row) => row.restaurantTableId === second)?.removedAt).toBeNull();
    });

    it("can't change a cancelled reservation", async () => {
      const created = await reserve(database(), host, 300);

      await cancelReservation(database(), host, created.id, { expectedVersion: 1 });

      await expect(
        setPlannedTables(database(), host, created.id, { expectedVersion: 2, tableIds: [] }),
      ).rejects.toMatchObject({ code: "RESERVATION_NOT_EDITABLE" });
    });
  });

  describe("lifecycle", () => {
    it("checks in a confirmed reservation", async () => {
      const created = await reserve(database(), host, 10);
      const result = await checkInReservation(database(), host, created.id, {
        expectedVersion: 1,
      });
      const reservation = await reservationRow(database(), created.id);

      expect(result.version).toBe(2);
      expect(reservation.status).toBe("CHECKED_IN");
      expect(reservation.checkedInAt).not.toBeNull();
      expect(await partyRow(database(), reservation.guestPartyId)).toMatchObject({
        status: "CHECKED_IN",
      });
      expect((await partyHistory(database(), reservation.guestPartyId)).map((row) => row.status)).toEqual(["EXPECTED", "CHECKED_IN"]);
    });

    it("checking in creates no session and no occupancy", async () => {
      const table = await tableFixture(database(), scenario);
      const created = await reserve(database(), host, 10, { tableIds: [table] });

      await checkInReservation(database(), host, created.id, { expectedVersion: 1 });

      const { getFloorStatus } = await import("@/modules/restaurant/services/floor-service");
      const floor = await getFloorStatus(database(), host);

      expect(floor.find((row) => row.id === table)).toMatchObject({
        availability: "AVAILABLE",
        session: null,
      });
    });

    it("cancels, releases the planned tables and updates the party and its history", async () => {
      const table = await tableFixture(database(), scenario);
      const created = await reserve(database(), host, 300, { tableIds: [table] });

      await cancelReservation(database(), host, created.id, {
        expectedVersion: 1,
        reason: "Changed plans",
      });

      const reservation = await reservationRow(database(), created.id);

      expect(reservation).toMatchObject({
        status: "CANCELLED",
        cancelledByUserId: host.userId,
        cancelReason: "Changed plans",
      });
      expect(reservation.cancelledAt).not.toBeNull();
      expect(await plannedRows(database(), created.id)).toMatchObject([
        { removalReason: "CANCELLED" },
      ]);
      expect((await partyRow(database(), reservation.guestPartyId)).status).toBe("CANCELLED");
      expect((await partyHistory(database(), reservation.guestPartyId)).at(-1)).toMatchObject({
        status: "CANCELLED",
        reason: "Changed plans",
      });
    });

    it("refuses an invalid transition", async () => {
      const created = await reserve(database(), host, 300);

      await cancelReservation(database(), host, created.id, { expectedVersion: 1 });

      await expect(
        checkInReservation(database(), host, created.id, { expectedVersion: 2 }),
      ).rejects.toMatchObject({ code: "INVALID_RESERVATION_TRANSITION" });
      await expect(
        cancelReservation(database(), host, created.id, { expectedVersion: 2 }),
      ).rejects.toMatchObject({ code: "INVALID_RESERVATION_TRANSITION" });
    });

    describe("no-show", () => {
      it("is refused before the post-grace boundary", async () => {
        const table = await tableFixture(database(), scenario);
        const created = await reserve(database(), host, -5, { tableIds: [table] });

        await expect(
          markReservationNoShow(database(), host, created.id, { expectedVersion: 1 }),
        ).rejects.toMatchObject({ code: "NO_SHOW_TOO_EARLY" });
        expect((await reservationRow(database(), created.id)).status).toBe("CONFIRMED");
      });

      it("is allowed after the boundary, records who and when, and releases the tables", async () => {
        const table = await tableFixture(database(), scenario);
        const created = await reserve(database(), host, -20, { tableIds: [table] });

        await markReservationNoShow(database(), host, created.id, { expectedVersion: 1 });

        const reservation = await reservationRow(database(), created.id);

        expect(reservation).toMatchObject({
          status: "NO_SHOW",
          noShowByUserId: host.userId,
        });
        expect(reservation.noShowAt).not.toBeNull();
        expect(await plannedRows(database(), created.id)).toMatchObject([
          { removalReason: "NO_SHOW" },
        ]);
        expect((await partyRow(database(), reservation.guestPartyId)).status).toBe("NO_SHOW");
      });

      it("follows the configured post-grace minutes", async () => {
        const created = await reserve(database(), host, -20);

        await setHoldWindows(database(), scenario.locationA, { postGrace: 45 });

        await expect(
          markReservationNoShow(database(), host, created.id, { expectedVersion: 1 }),
        ).rejects.toMatchObject({ code: "NO_SHOW_TOO_EARLY" });
      });

      it("is refused unless the reservation is confirmed", async () => {
        const pending = await reserve(database(), host, -20, { status: "PENDING" });
        const checkedIn = await reserve(database(), host, -20);

        await checkInReservation(database(), host, checkedIn.id, { expectedVersion: 1 });

        await expect(
          markReservationNoShow(database(), host, pending.id, { expectedVersion: 1 }),
        ).rejects.toMatchObject({ code: "NO_SHOW_REQUIRES_CONFIRMED" });
        await expect(
          markReservationNoShow(database(), host, checkedIn.id, { expectedVersion: 2 }),
        ).rejects.toMatchObject({ code: "NO_SHOW_REQUIRES_CONFIRMED" });
      });
    });
  });

  describe("listing", () => {
    it("lists a business date's reservations in time order with planned tables", async () => {
      const table = await tableFixture(database(), scenario);
      const later = await reserve(database(), host, 240, { guestName: "Later" });
      const earlier = await reserve(database(), host, 180, {
        guestName: "Earlier",
        tableIds: [table],
      });
      const views = await listReservations(database(), host, {
        fromBusinessDate: "2000-01-01",
        toBusinessDate: "2100-01-01",
      });
      const ours = views.filter((view) => [later.id, earlier.id].includes(view.id));

      expect(ours.map((view) => view.guestName)).toEqual(["Earlier", "Later"]);
      expect(ours[0]!.plannedTables).toMatchObject([{ id: table }]);
      expect(ours[0]!.actualSeating).toBeNull();
    });
  });
});
