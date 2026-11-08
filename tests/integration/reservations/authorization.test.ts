import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { ROLE_CATALOG } from "@/modules/auth/role-catalog";
import type { Actor } from "@/modules/auth/types";
import { listTableHoldIndicators } from "@/modules/reservations/services/hold-service";
import { recommendTablesFor } from "@/modules/reservations/services/recommendation-service";
import {
  cancelReservation,
  checkInReservation,
  confirmReservation,
  createReservation,
  getReservation,
  listReservations,
  markReservationNoShow,
  previewPlanningConflicts,
  setPlannedTables,
  updateReservation,
} from "@/modules/reservations/services/reservation-service";
import {
  addToWaitlist,
  assignWaitlistTables,
  listWaitlist,
  notifyWaitlistEntry,
  removeWaitlistEntry,
  updateWaitlistEntry,
} from "@/modules/reservations/services/waitlist-service";
import {
  seatReservationParty,
  seatWaitlistParty,
  seatWalkIn,
} from "@/workflows/seat-guest-party/seat-guest-party";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  localAt,
  RESERVATION_HOST_PERMISSIONS,
  reservationHost,
  reserve,
} from "../../fixtures/reservation-fixtures";
import {
  createRestaurantScenario,
  tableFixture,
  type RestaurantScenario,
} from "../../fixtures/restaurant-fixtures";

const database = () => getDatabase();

describe("reservations and waitlist authorization", () => {
  let scenario: RestaurantScenario;
  let host: Actor;
  let nobody: Actor;

  beforeEach(async () => {
    scenario = await createRestaurantScenario(database());
    host = await reservationHost(database(), scenario);
    nobody = await actorWith(database(), scenario, []);
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  const input = {
    guestName: "Guest",
    partySize: 2,
    source: "PHONE" as const,
    ...localAt(180),
  };

  it("refuses every reservation and waitlist operation without the permission", async () => {
    const reservation = await reserve(database(), host, 200);
    const entry = await addToWaitlist(database(), host, { guestName: "W", partySize: 2 });
    const table = await tableFixture(database(), scenario);
    const denied = { code: "PERMISSION_DENIED" };

    await expect(createReservation(database(), nobody, input)).rejects.toMatchObject(denied);
    await expect(
      updateReservation(database(), nobody, reservation.id, {
        ...input,
        expectedVersion: 1,
        expectedDurationMinutes: 60,
      }),
    ).rejects.toMatchObject(denied);
    await expect(
      confirmReservation(database(), nobody, reservation.id, { expectedVersion: 1 }),
    ).rejects.toMatchObject(denied);
    await expect(
      checkInReservation(database(), nobody, reservation.id, { expectedVersion: 1 }),
    ).rejects.toMatchObject(denied);
    await expect(
      cancelReservation(database(), nobody, reservation.id, { expectedVersion: 1 }),
    ).rejects.toMatchObject(denied);
    await expect(
      markReservationNoShow(database(), nobody, reservation.id, { expectedVersion: 1 }),
    ).rejects.toMatchObject(denied);
    await expect(
      setPlannedTables(database(), nobody, reservation.id, { expectedVersion: 1, tableIds: [] }),
    ).rejects.toMatchObject(denied);
    await expect(
      listReservations(database(), nobody, { fromBusinessDate: "2000-01-01", toBusinessDate: "2100-01-01" }),
    ).rejects.toMatchObject(denied);
    await expect(getReservation(database(), nobody, reservation.id)).rejects.toMatchObject(denied);
    await expect(
      previewPlanningConflicts(database(), nobody, {
        tableIds: [],
        ...localAt(10),
        expectedDurationMinutes: 60,
        partySize: 2,
      }),
    ).rejects.toMatchObject(denied);
    await expect(
      addToWaitlist(database(), nobody, { guestName: "X", partySize: 2 }),
    ).rejects.toMatchObject(denied);
    await expect(listWaitlist(database(), nobody)).rejects.toMatchObject(denied);
    await expect(
      updateWaitlistEntry(database(), nobody, entry.id, { expectedVersion: 1, quotedWaitMinutes: 5 }),
    ).rejects.toMatchObject(denied);
    await expect(
      notifyWaitlistEntry(database(), nobody, entry.id, { expectedVersion: 1 }),
    ).rejects.toMatchObject(denied);
    await expect(
      assignWaitlistTables(database(), nobody, entry.id, { expectedVersion: 1, tableIds: [table] }),
    ).rejects.toMatchObject(denied);
    await expect(
      removeWaitlistEntry(database(), nobody, entry.id, { expectedVersion: 1, outcome: "LEFT" }),
    ).rejects.toMatchObject(denied);
    await expect(recommendTablesFor(database(), nobody, { partySize: 2 })).rejects.toMatchObject(denied);
    await expect(listTableHoldIndicators(database(), nobody)).rejects.toMatchObject(denied);
  });

  it("separates viewing from managing, notifying and seating", async () => {
    const viewer = await actorWith(database(), scenario, ["reservations.view", "waitlist.view"]);
    const reservation = await reserve(database(), host, 200);
    const entry = await addToWaitlist(database(), host, { guestName: "W", partySize: 2 });
    const table = await tableFixture(database(), scenario);

    expect(await listReservations(database(), viewer, { fromBusinessDate: "2000-01-01", toBusinessDate: "2100-01-01" })).not.toHaveLength(0);
    expect(await listWaitlist(database(), viewer)).toHaveLength(1);
    await expect(createReservation(database(), viewer, input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      addToWaitlist(database(), viewer, { guestName: "X", partySize: 2 }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      notifyWaitlistEntry(database(), viewer, entry.id, { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      seatReservationParty(database(), viewer, {
        reservationId: reservation.id,
        expectedVersion: 1,
        tableIds: [table],
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      seatWaitlistParty(database(), viewer, { entryId: entry.id, expectedVersion: 1, tableIds: [table] }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("needs both the seating permission and the reservation or waitlist one", async () => {
    const seatOnly = await actorWith(database(), scenario, ["restaurant.seat", "restaurant.view"]);
    const manageOnly = await actorWith(database(), scenario, ["reservations.manage", "waitlist.manage", "waitlist.seat"]);
    const reservation = await reserve(database(), host, 200);
    const entry = await addToWaitlist(database(), host, { guestName: "W", partySize: 2 });
    const table = await tableFixture(database(), scenario);
    const denied = { code: "PERMISSION_DENIED" };

    await expect(
      seatReservationParty(database(), seatOnly, { reservationId: reservation.id, expectedVersion: 1, tableIds: [table] }),
    ).rejects.toMatchObject(denied);
    await expect(
      seatReservationParty(database(), manageOnly, { reservationId: reservation.id, expectedVersion: 1, tableIds: [table] }),
    ).rejects.toMatchObject(denied);
    await expect(
      seatWaitlistParty(database(), seatOnly, { entryId: entry.id, expectedVersion: 1, tableIds: [table] }),
    ).rejects.toMatchObject(denied);
    await expect(
      seatWalkIn(database(), seatOnly, { guestName: "W", partySize: 2, tableIds: [table] }),
    ).rejects.toMatchObject(denied);
  });

  it("makes another location's records look absent", async () => {
    const atB = await actorWith(database(), scenario, RESERVATION_HOST_PERMISSIONS, scenario.locationB);
    const reservation = await reserve(database(), host, 200);
    const entry = await addToWaitlist(database(), host, { guestName: "W", partySize: 2 });
    const notFound = { code: "NOT_FOUND" };

    await expect(getReservation(database(), atB, reservation.id)).rejects.toMatchObject(notFound);
    await expect(
      cancelReservation(database(), atB, reservation.id, { expectedVersion: 1 }),
    ).rejects.toMatchObject(notFound);
    await expect(
      notifyWaitlistEntry(database(), atB, entry.id, { expectedVersion: 1 }),
    ).rejects.toMatchObject(notFound);
    expect(
      await listReservations(database(), atB, { fromBusinessDate: "2000-01-01", toBusinessDate: "2100-01-01" }),
    ).toEqual([]);
    expect(await listWaitlist(database(), atB)).toEqual([]);
  });

  it("gives the Host the normal permissions and no manager override", () => {
    const hostRole = ROLE_CATALOG.find((role) => role.code === "HOST")!;
    const manager = ROLE_CATALOG.find((role) => role.code === "MANAGER")!;
    const server = ROLE_CATALOG.find((role) => role.code === "SERVER")!;

    expect(hostRole.permissions).toEqual(
      expect.arrayContaining([
        "reservations.view",
        "reservations.manage",
        "waitlist.view",
        "waitlist.manage",
        "waitlist.notify",
        "waitlist.seat",
      ]),
    );
    expect(hostRole.permissions).not.toContain("reservations.override-hold");
    expect(manager.permissions).toContain("reservations.override-hold");
    expect(server.permissions.filter((code) => /^(reservations|waitlist)\./.test(code))).toEqual([]);
  });

  describe("module boundaries", () => {
    function sources(directory: string): string[] {
      return readdirSync(directory).flatMap((name) => {
        const full = path.join(directory, name);

        if (statSync(full).isDirectory()) {
          return sources(full);
        }

        return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
      });
    }

    it("never reads restricted HR data, compensation or security roles", () => {
      const text = sources(path.join(process.cwd(), "src", "modules", "reservations"))
        .map((file) => readFileSync(file, "utf8"))
        .join("\n");

      for (const forbidden of [
        "employeePositionCompensation",
        "employeeDisciplinaryActions",
        "employeePerformanceReviews",
        "employeeNotes",
        "employeeDocuments",
        "userRoles",
        "rolePermissions",
        "hr.compensation",
      ]) {
        expect(text).not.toContain(forbidden);
      }
    });

    it("never imports Drizzle into the UI", () => {
      const roots = ["components/reservations", "components/waitlist", "app/(app)/host"];

      for (const root of roots) {
        const directory = path.join(process.cwd(), "src", ...root.split("/"));

        try {
          statSync(directory);
        } catch {
          continue;
        }

        for (const file of sources(directory).concat(
          readdirSync(directory).filter((name) => name.endsWith(".tsx")).map((name) => path.join(directory, name)),
        )) {
          expect(readFileSync(file, "utf8")).not.toMatch(/drizzle-orm|@\/db/);
        }
      }
    });
  });
});
