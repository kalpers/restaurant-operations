import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { outboxEvents } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import {
  cancelReservation,
  checkInReservation,
  markReservationNoShow,
  updateReservation,
} from "@/modules/reservations/services/reservation-service";
import { seatReservationParty } from "@/workflows/seat-guest-party/seat-guest-party";

import { clearEmployeeData } from "../../fixtures/employee-fixtures";
import { localAt, reservationHost, reserve } from "../../fixtures/reservation-fixtures";
import {
  createRestaurantScenario,
  tableFixture,
  type RestaurantScenario,
} from "../../fixtures/restaurant-fixtures";

const database = () => getDatabase();

async function eventsFor(reservationId: string) {
  return database()
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateId, reservationId))
    .orderBy(asc(outboxEvents.createdAt));
}

// Phase 24 policy 18: staff reservation changes tell open boards, after commit, IDs only.
describe("reservation realtime events", () => {
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

  it("writes one event per change with the reservation ID only", async () => {
    const created = await reserve(database(), host, 180);

    await updateReservation(database(), host, created.id, {
      expectedVersion: 1,
      guestName: "Renamed",
      partySize: 4,
      phone: null,
      email: null,
      specialRequests: null,
      ...localAt(240),
      expectedDurationMinutes: 90,
      notes: null,
    });
    await checkInReservation(database(), host, created.id, { expectedVersion: 2 });

    const events = await eventsFor(created.id);

    expect(events.map((event) => event.eventType)).toEqual([
      "reservation.created",
      "reservation.updated",
      "reservation.checked-in",
    ]);

    for (const event of events) {
      expect(event).toMatchObject({
        aggregateType: "reservation",
        locationId: host.locationId,
        organizationId: host.organizationId,
        payload: { reservationId: created.id },
      });
      expect(Object.keys(event.payload as object)).toEqual(["reservationId"]);
    }
  });

  it("writes cancelled, no-show and seated events", async () => {
    const cancelled = await reserve(database(), host, 180);
    const late = await reserve(database(), host, -20, { tableIds: [await tableFixture(database(), scenario)] });
    const table = await tableFixture(database(), scenario);
    const seated = await reserve(database(), host, 5, { tableIds: [table] });

    await cancelReservation(database(), host, cancelled.id, { expectedVersion: 1 });
    await markReservationNoShow(database(), host, late.id, { expectedVersion: 1 });
    await seatReservationParty(database(), host, {
      reservationId: seated.id,
      expectedVersion: 1,
      tableIds: [table],
    });

    expect((await eventsFor(cancelled.id)).map((event) => event.eventType)).toEqual([
      "reservation.created",
      "reservation.cancelled",
    ]);
    expect((await eventsFor(late.id)).map((event) => event.eventType)).toEqual([
      "reservation.created",
      "reservation.no-show",
    ]);
    expect((await eventsFor(seated.id)).map((event) => event.eventType)).toEqual([
      "reservation.created",
      "reservation.seated",
    ]);
  });

  it("writes nothing when the change is refused", async () => {
    const created = await reserve(database(), host, 180);

    await expect(
      checkInReservation(database(), host, created.id, { expectedVersion: 7 }),
    ).rejects.toBeDefined();
    expect((await eventsFor(created.id)).map((event) => event.eventType)).toEqual([
      "reservation.created",
    ]);
  });
});
