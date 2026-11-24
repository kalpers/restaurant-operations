import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { readConstraintName } from "@/db/helpers/database-errors";
import { eventBookings, reservationHoldOverrides } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { getBookedCovers } from "@/modules/reservations/queries/booked-demand";
import { changeEventStatus, createEvent, getEvent, listEvents, updateEvent, type EventInput } from "@/modules/reservations/services/event-service";
import { listHostTables } from "@/modules/reservations/services/recommendation-service";
import { listTableHoldIndicators } from "@/modules/reservations/services/hold-service";
import { setPlannedTables } from "@/modules/reservations/services/reservation-service";
import { addToWaitlist, assignWaitlistTables } from "@/modules/reservations/services/waitlist-service";
import { AppError } from "@/shared/errors/app-error";
import { completeTableSession } from "@/workflows/end-table-session/end-table-session";
import { seatEventParty, seatWalkIn } from "@/workflows/seat-guest-party/seat-guest-party";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import {
  localAt,
  partyRow,
  RESERVATION_HOST_PERMISSIONS,
  RESERVATION_MANAGER_PERMISSIONS,
  reserve,
  TIME_ZONE,
} from "../../fixtures/reservation-fixtures";
import { createRestaurantScenario, sessionRow, tableFixture, type RestaurantScenario } from "../../fixtures/restaurant-fixtures";

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) {
      return error.code;
    }

    return readConstraintName(error) ?? (error as Error).message;
  }

  return undefined;
}

describe("events and private dining (Phase 36 part 3)", () => {
  let scenario: RestaurantScenario;
  let manager: Actor;
  let host: Actor;
  let tableA: string;
  let tableB: string;
  let barTable: string;

  beforeEach(async () => {
    await clearEmployeeData(database());
    scenario = await createRestaurantScenario(database());
    manager = await actorWith(database(), scenario, [
      ...RESERVATION_MANAGER_PERMISSIONS,
      "events.view",
      "events.manage",
      "guests.contact.view",
    ]);
    host = await actorWith(database(), scenario, [...RESERVATION_HOST_PERMISSIONS, "events.view"]);
    tableA = await tableFixture(database(), scenario, { capacity: 6, tableNumber: "A1" });
    tableB = await tableFixture(database(), scenario, { capacity: 6, tableNumber: "A2" });
    barTable = await tableFixture(database(), scenario, { areaId: scenario.bar, capacity: 4, tableNumber: "B1" });
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  /** An event from `startIn` minutes from now lasting `minutes`, on table A by default. */
  function eventInput(startIn: number, minutes: number, overrides: Partial<EventInput> = {}): EventInput {
    const start = localAt(startIn);
    const end = localAt(startIn + minutes);

    return {
      name: "Rehearsal dinner",
      guestName: "Pat Lee",
      partySize: 10,
      phone: "555-0100",
      localDate: start.localDate,
      startTime: start.localTime,
      endTime: end.localTime,
      setupMinutes: 30,
      teardownMinutes: 15,
      spaceScope: "TABLES",
      tableIds: [tableA],
      ...overrides,
    };
  }

  it("books an inquiry with its own party, holding nothing", async () => {
    const event = await createEvent(database(), manager, eventInput(180, 120));

    expect(event).toMatchObject({ status: "INQUIRY", eventNumber: expect.stringMatching(/^EV-\d{6}$/), guestName: "Pat Lee", partySize: 10 });
    expect(event.contact).toEqual({ phone: "555-0100", email: null });
    expect((await partyRow(database(), event.guestPartyId)).status).toBe("EXPECTED");

    // An inquiry doesn't hold the table.
    expect(await codeOf(reserve(database(), manager, 180, { tableIds: [tableA] }))).toBeUndefined();
  });

  it("refuses to hold a space that is already planned, and holds it once free", async () => {
    const reservation = await reserve(database(), manager, 200, { tableIds: [tableA] });
    const event = await createEvent(database(), manager, eventInput(180, 120));

    expect(await codeOf(changeEventStatus(database(), manager, event.id, { status: "CONFIRMED", expectedVersion: event.version }))).toBe(
      "EVENT_CONFLICT",
    );

    // Move the reservation to another table; now the event can be confirmed.
    await setPlannedTables(database(), manager, reservation.id, { expectedVersion: reservation.version, tableIds: [tableB] });

    const confirmed = await changeEventStatus(database(), manager, event.id, { status: "CONFIRMED", expectedVersion: event.version });

    expect(confirmed.status).toBe("CONFIRMED");

    // Creating one held from the start is checked the same way.
    expect(await codeOf(createEvent(database(), manager, { ...eventInput(170, 60), status: "TENTATIVE" }))).toBe("EVENT_CONFLICT");
  });

  it("keeps reservations and the waitlist off a held space over its whole block", async () => {
    await createEvent(database(), manager, { ...eventInput(180, 120), status: "TENTATIVE" });

    // Setup (30 minutes) and teardown (15) are part of the block.
    expect(await codeOf(reserve(database(), manager, 130, { tableIds: [tableA] }))).toBe("EVENT_CONFLICT");
    expect(await codeOf(reserve(database(), manager, 310, { tableIds: [tableA] }))).toBe("EVENT_CONFLICT");
    expect(await codeOf(reserve(database(), manager, 180, { tableIds: [tableB] }))).toBeUndefined();
    expect(await codeOf(reserve(database(), manager, 180))).toBeUndefined();

    // A waitlist party can't be given a table an event holds now.
    await createEvent(database(), manager, { ...eventInput(-15, 120, { tableIds: [tableB] }), status: "CONFIRMED" });

    const entry = await addToWaitlist(database(), manager, { guestName: "Walk Up", partySize: 2 });

    expect(await codeOf(assignWaitlistTables(database(), manager, entry.id, { expectedVersion: entry.version, tableIds: [tableB] }))).toBe(
      "EVENT_CONFLICT",
    );
  });

  it("books a whole area, and a buyout blocks every reservation", async () => {
    const area = await createEvent(database(), manager, {
      ...eventInput(180, 120, { spaceScope: "AREA", restaurantAreaId: scenario.bar, tableIds: [] }),
      status: "CONFIRMED",
    });

    expect(area.area?.id).toBe(scenario.bar);
    expect(await codeOf(reserve(database(), manager, 200, { tableIds: [barTable] }))).toBe("EVENT_CONFLICT");

    const buyout = await createEvent(database(), manager, {
      ...eventInput(24 * 60, 180, { spaceScope: "LOCATION", tableIds: [] }),
      status: "CONFIRMED",
    });

    expect(buyout.area).toBeNull();
    expect(await codeOf(reserve(database(), manager, 24 * 60 + 30))).toBe("EVENT_CONFLICT");
    // An area event and a buyout at the same time clash.
    expect(
      await codeOf(createEvent(database(), manager, { ...eventInput(24 * 60, 60, { tableIds: [tableB] }), status: "TENTATIVE" })),
    ).toBe("EVENT_CONFLICT");
  });

  it("holds the event's tables at the host stand, with a manager override recorded", async () => {
    const event = await createEvent(database(), manager, { ...eventInput(-10, 120), status: "CONFIRMED" });

    expect((await listHostTables(database(), host)).find((table) => table.id === tableA)!.held).toBe(true);
    expect((await listTableHoldIndicators(database(), host)).find((hold) => hold.tableId === tableA)).toMatchObject({
      kind: "EVENT",
      active: true,
      reservationId: event.id,
    });

    expect(await codeOf(seatWalkIn(database(), host, { guestName: "Walk In", partySize: 2, tableIds: [tableA] }))).toBe("EVENT_HOLD_ACTIVE");
    expect(
      await codeOf(seatWalkIn(database(), host, { guestName: "Walk In", partySize: 2, tableIds: [tableA], holdOverrideReason: "Quick drink" })),
    ).toBe("PERMISSION_DENIED");

    const seated = await seatWalkIn(database(), manager, { guestName: "Walk In", partySize: 2, tableIds: [tableA], holdOverrideReason: "Quick drink" });
    const [override] = await database().select().from(reservationHoldOverrides).where(eq(reservationHoldOverrides.tableSessionId, seated.id));

    expect(override).toMatchObject({ category: "EVENT_HOLD_OVERRIDE", eventBookingId: event.id, reservationId: null, reason: "Quick drink" });
  });

  it("seats a confirmed event as one session and completes it when the session ends", async () => {
    const event = await createEvent(database(), manager, eventInput(-10, 120, { tableIds: [tableA, tableB], partySize: 12 }));

    expect(await codeOf(seatEventParty(database(), host, { eventId: event.id, expectedVersion: event.version }))).toBe("EVENT_NOT_CONFIRMED");

    const confirmed = await changeEventStatus(database(), manager, event.id, { status: "CONFIRMED", expectedVersion: event.version });
    const seated = await seatEventParty(database(), host, { eventId: event.id, expectedVersion: confirmed.version, serverEmployeeId: null });

    expect(seated.guestPartyId).toBe(event.guestPartyId);
    expect((await partyRow(database(), event.guestPartyId)).status).toBe("SEATED");

    const session = await sessionRow(database(), seated.id);

    await completeTableSession(database(), manager, seated.id, { expectedVersion: session.version });

    const done = await getEvent(database(), manager, event.id);

    expect(done.status).toBe("COMPLETED");
    expect(done.spend).toEqual({ subtotal: "0.00", checks: 0 });

    // A finished event is frozen.
    expect(await codeOf(changeEventStatus(database(), manager, event.id, { status: "CANCELLED", reason: "x", expectedVersion: done.version }))).toBe(
      "EVENT_STATUS_INVALID",
    );
    expect(await codeOf(database().update(eventBookings).set({ name: "Changed" }).where(eq(eventBookings.id, event.id)))).toBe(
      "event_bookings_finished_frozen",
    );
    expect(await codeOf(database().delete(eventBookings).where(eq(eventBookings.id, event.id)))).toBe("event_bookings_no_delete");
  });

  it("cancels with a reason, cancelling the party and releasing the space", async () => {
    const event = await createEvent(database(), manager, { ...eventInput(180, 120), status: "CONFIRMED" });

    expect(await codeOf(changeEventStatus(database(), manager, event.id, { status: "CANCELLED", expectedVersion: event.version }))).toBe(
      "REASON_REQUIRED",
    );

    const cancelled = await changeEventStatus(database(), manager, event.id, {
      status: "CANCELLED",
      reason: "Client postponed",
      expectedVersion: event.version,
    });

    expect(cancelled).toMatchObject({ status: "CANCELLED", cancelReason: "Client postponed" });
    expect((await partyRow(database(), event.guestPartyId)).status).toBe("CANCELLED");
    expect(await codeOf(reserve(database(), manager, 200, { tableIds: [tableA] }))).toBeUndefined();
  });

  it("records deposits and minimum spend as information, checked as a whole", async () => {
    const event = await createEvent(database(), manager, eventInput(180, 120));

    expect(
      await codeOf(
        updateEvent(database(), manager, event.id, { ...eventInput(180, 120), depositReceived: "200.00", expectedVersion: event.version }),
      ),
    ).toBe("DEPOSIT_INCOMPLETE");
    expect(
      await codeOf(
        updateEvent(database(), manager, event.id, { ...eventInput(180, 120), notes: "Card 4111111111111111", expectedVersion: event.version }),
      ),
    ).toBe("CARD_DATA_REFUSED");

    const updated = await updateEvent(database(), manager, event.id, {
      ...eventInput(180, 120),
      partySize: 14,
      minimumSpend: "1500.00",
      depositAgreed: "300.00",
      depositReceived: "300.00",
      depositReceivedOn: localAt(0).localDate,
      depositMethod: "EXTERNAL_CARD",
      depositReference: "Auth 4821",
      expectedVersion: event.version,
    });

    expect(updated).toMatchObject({ partySize: 14, minimumSpend: "1500.00", depositReceived: "300.00", depositMethod: "EXTERNAL_CARD" });
  });

  it("refuses an event's tables across two areas, and checks permissions", async () => {
    expect(await codeOf(createEvent(database(), manager, eventInput(180, 60, { tableIds: [tableA, barTable] })))).toBe("EVENT_ONE_AREA");
    expect(await codeOf(createEvent(database(), host, eventInput(180, 60)))).toBe("PERMISSION_DENIED");

    const nobody = await actorWith(database(), scenario, ["reservations.view"]);

    expect(await codeOf(listEvents(database(), nobody, { from: localAt(0).localDate, to: localAt(0).localDate }))).toBe("PERMISSION_DENIED");

    // A host sees the event but not its contact details.
    const event = await createEvent(database(), manager, eventInput(180, 60));

    expect((await getEvent(database(), host, event.id)).contact).toBeNull();
  });

  it("counts held events' guests as booked covers for the demand forecast", async () => {
    const start = localAt(24 * 60);

    await createEvent(database(), manager, { ...eventInput(24 * 60, 60, { partySize: 20 }), status: "TENTATIVE" });
    await createEvent(database(), manager, eventInput(24 * 60, 60, { partySize: 99, tableIds: [tableB] }));

    const covers = await getBookedCovers(database(), {
      locationId: scenario.locationA,
      timeZone: TIME_ZONE,
      fromDate: start.localDate,
      toDate: start.localDate,
    });

    // The inquiry (99) holds nothing and isn't counted.
    expect(covers.reduce((sum, row) => sum + row.covers, 0)).toBe(20);
  });
});
