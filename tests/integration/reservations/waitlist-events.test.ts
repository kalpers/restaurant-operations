import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { outboxEvents } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import {
  cancelReservation,
  checkInReservation,
} from "@/modules/reservations/services/reservation-service";
import {
  addToWaitlist,
  assignWaitlistTables,
  notifyWaitlistEntry,
  removeWaitlistEntry,
  updateWaitlistEntry,
} from "@/modules/reservations/services/waitlist-service";
import { cancelTableSession } from "@/workflows/end-table-session/end-table-session";
import { seatWaitlistParty } from "@/workflows/seat-guest-party/seat-guest-party";

import { clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  reservationHost,
  reservationManager,
  reservationRow,
  reserve,
} from "../../fixtures/reservation-fixtures";
import {
  createRestaurantScenario,
  tableFixture,
  type RestaurantScenario,
} from "../../fixtures/restaurant-fixtures";

const database = () => getDatabase();

async function eventsFor(aggregateId: string) {
  return database()
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateId, aggregateId))
    .orderBy(asc(outboxEvents.sequence));
}

const types = (rows: { eventType: string }[]) => rows.map((row) => row.eventType);

// Phase 27 policies 2–3: waitlist changes tell open boards, after commit, IDs only.
describe("waitlist realtime events", () => {
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

  const add = () =>
    addToWaitlist(database(), host, {
      guestName: "Private Name",
      partySize: 2,
      phone: "555-0100",
      quotedWaitMinutes: 15,
    });

  it("writes one event per change with the entry ID only", async () => {
    const table = await tableFixture(database(), scenario);
    const entry = await add();

    await updateWaitlistEntry(database(), host, entry.id, { expectedVersion: 1, quotedWaitMinutes: 25 });
    await notifyWaitlistEntry(database(), host, entry.id, { expectedVersion: 2 });
    await assignWaitlistTables(database(), host, entry.id, { expectedVersion: 3, tableIds: [table] });
    await seatWaitlistParty(database(), host, { entryId: entry.id, expectedVersion: 4, tableIds: [table] });

    const events = await eventsFor(entry.id);

    expect(types(events)).toEqual([
      "waitlist.entry-added",
      "waitlist.entry-updated",
      "waitlist.entry-notified",
      "waitlist.tables-assigned",
      "waitlist.entry-seated",
    ]);

    for (const event of events) {
      expect(event).toMatchObject({
        aggregateType: "waitlist_entry",
        organizationId: host.organizationId,
        locationId: host.locationId,
        recipientUserId: null,
        payload: { waitlistEntryId: entry.id },
      });
      expect(Object.keys(event.payload as object)).toEqual(["waitlistEntryId"]);
      expect(JSON.stringify(event.payload)).not.toMatch(/Private Name|555-0100/);
    }
  });

  it("writes removed when the party leaves, and updated when a mistaken seating is undone", async () => {
    const left = await add();
    const undone = await add();
    const table = await tableFixture(database(), scenario);

    await removeWaitlistEntry(database(), host, left.id, { expectedVersion: 1, outcome: "LEFT" });

    const seated = await seatWaitlistParty(database(), host, {
      entryId: undone.id,
      expectedVersion: 1,
      tableIds: [table],
    });

    await cancelTableSession(database(), manager, seated.id, {
      reason: "Wrong party",
      expectedVersion: seated.version,
    });

    expect(types(await eventsFor(left.id))).toEqual(["waitlist.entry-added", "waitlist.entry-removed"]);
    expect(types(await eventsFor(undone.id))).toEqual([
      "waitlist.entry-added",
      "waitlist.entry-seated",
      "waitlist.entry-updated",
    ]);
  });

  it("writes removed when a waiting reservation party's reservation is cancelled", async () => {
    const reservation = await reserve(database(), host, 10);

    await checkInReservation(database(), host, reservation.id, { expectedVersion: 1 });

    const { guestPartyId } = await reservationRow(database(), reservation.id);
    const entry = await addToWaitlist(database(), host, { guestPartyId });

    await cancelReservation(database(), host, reservation.id, { expectedVersion: 2 });

    expect(types(await eventsFor(entry.id))).toEqual(["waitlist.entry-added", "waitlist.entry-removed"]);
  });

  it("writes nothing when the change is refused", async () => {
    const entry = await add();

    await expect(
      notifyWaitlistEntry(database(), host, entry.id, { expectedVersion: 9 }),
    ).rejects.toBeDefined();
    await expect(
      removeWaitlistEntry(database(), host, entry.id, { expectedVersion: 9, outcome: "LEFT" }),
    ).rejects.toBeDefined();

    expect(types(await eventsFor(entry.id))).toEqual(["waitlist.entry-added"]);
  });
});
