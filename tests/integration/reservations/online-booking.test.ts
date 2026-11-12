import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  auditEvents,
  guestMessages,
  guestParties,
  guestPartyAllergies,
  guestPartyMessageConsents,
  locations,
  messageSuppressions,
  outboxEvents,
  publicThrottles,
  reservationManageLinks,
  reservations,
} from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { hashToken, unsubscribeByToken } from "@/modules/reservations/services/guest-message-service";
import {
  cancelReservationByGuest,
  createOnlineReservation,
  getManagedReservation,
  getOnlineBookingSettings,
  getPublicAvailability,
  replaceBookingPeriods,
  saveOnlineBookingSettings,
  type OnlineBookingInput,
} from "@/modules/reservations/services/online-booking-service";
import { confirmReservation, listReservations } from "@/modules/reservations/services/reservation-service";
import { AuthorizationError, TooManyRequestsError } from "@/shared/errors/app-error";
import { addDays, localDateOf } from "@/shared/time/zoned-time";

import { allergenList } from "../../fixtures/allergen-fixtures";
import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import { RESERVATION_HOST_PERMISSIONS, TIME_ZONE } from "../../fixtures/reservation-fixtures";
import { createRestaurantScenario, type RestaurantScenario } from "../../fixtures/restaurant-fixtures";

// Phase 22 policies 7-12: settings, availability, the public booking, its limits and throttles,
// the manage link and the email opt-out. The public commands act as a GUEST.

const database = () => getDatabase();
const guestContext = { clientIp: null };

describe("online booking (Phase 22)", () => {
  let scenario: RestaurantScenario;
  let manager: Actor;
  let code: string;
  let date: string;

  beforeEach(async () => {
    // Throttle windows would otherwise carry over from the previous test.
    await database().delete(publicThrottles);
    scenario = await createRestaurantScenario(database());
    manager = await actorWith(database(), scenario, [
      ...RESERVATION_HOST_PERMISSIONS,
      "reservations.online.manage",
      "messages.view",
      "guests.view",
    ]);

    const [location] = await database().select().from(locations).where(eq(locations.id, scenario.locationA));

    code = location!.locationCode;
    date = addDays(localDateOf(new Date(), TIME_ZONE), 2);
    await enable();
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  async function enable(overrides: Partial<Parameters<typeof saveOnlineBookingSettings>[2]> = {}) {
    const current = await getOnlineBookingSettings(database(), manager);

    await saveOnlineBookingSettings(database(), manager, {
      enabled: true,
      requiresApproval: false,
      maxPartySize: 6,
      minLeadMinutes: 60,
      maxDaysAhead: 30,
      slotIntervalMinutes: 30,
      maxCoversPerSlot: 8,
      reminderHoursBefore: 24,
      publicNote: null,
      ...overrides,
      expectedVersion: current.version,
    });
    await replaceBookingPeriods(
      database(),
      manager,
      [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startsAt: "17:00", endsAt: "21:00" })),
    );
  }

  const booking = (overrides: Partial<OnlineBookingInput> = {}): OnlineBookingInput => ({
    localDate: date,
    localTime: "19:00",
    partySize: 4,
    guestName: "Ana Online",
    phone: "(555) 123-4567",
    email: "ana@example.com",
    specialRequests: null,
    messageConsent: { sms: true, email: true },
    allergies: [],
    website: "",
    idempotencyKey: randomUUID(),
    ...overrides,
  });

  const book = (overrides: Partial<OnlineBookingInput> = {}) =>
    createOnlineReservation(database(), code, booking(overrides), guestContext);

  async function reservationFor(reference: string) {
    const rows = await database().select().from(reservations).where(eq(reservations.locationId, scenario.locationA));

    return rows.find((row) => `R-${row.id.replaceAll("-", "").slice(0, 8).toUpperCase()}` === reference)!;
  }

  const tokenOf = (url: string) => url.split("/").at(-1)!;

  describe("settings (policy 7)", () => {
    it("starts off, saves with a version and refuses without the permission", async () => {
      const settings = await getOnlineBookingSettings(database(), manager);

      expect(settings).toMatchObject({ enabled: true, slotIntervalMinutes: 30, maxCoversPerSlot: 8 });
      expect(settings.periods).toHaveLength(7);
      await expect(
        saveOnlineBookingSettings(database(), manager, { ...settings, expectedVersion: settings.version! - 1 }),
      ).rejects.toMatchObject({ name: "ConcurrencyError" });
      await expect(getOnlineBookingSettings(database(), await actorWith(database(), scenario, ["reservations.view"]))).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    });

    it("refuses overlapping booking hours", async () => {
      await expect(
        replaceBookingPeriods(database(), manager, [
          { weekday: 1, startsAt: "11:00", endsAt: "15:00" },
          { weekday: 1, startsAt: "14:00", endsAt: "20:00" },
        ]),
      ).rejects.toMatchObject({ code: "INVALID_BOOKING_HOURS" });
    });

    it("answers a closed location and an unknown code the same way", async () => {
      const current = await getOnlineBookingSettings(database(), manager);

      await saveOnlineBookingSettings(database(), manager, { ...current, enabled: false, expectedVersion: current.version });

      for (const target of [code, "NO_SUCH_PLACE"]) {
        await expect(getPublicAvailability(database(), target, { localDate: date, partySize: 2 }, guestContext)).rejects.toMatchObject({
          code: "ONLINE_BOOKING_CLOSED",
        });
      }
    });
  });

  describe("availability and booking (policies 8 and 9)", () => {
    it("offers the period's times and matches the code case-insensitively", async () => {
      const { times } = await getPublicAvailability(database(), code.toLowerCase(), { localDate: date, partySize: 2 }, guestContext);

      expect(times).toEqual(["17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00", "20:30"]);
    });

    it("books as a GUEST: party, ONLINE reservation, allergies, consents, link, message, audit and event together", async () => {
      const list = await allergenList(database(), scenario.owner);
      const result = await book({ allergies: [{ code: "PEANUTS", severity: "SEVERE" }] });

      expect(result).toMatchObject({ status: "CONFIRMED", localDate: date, localTime: "19:00", partySize: 4 });
      expect(result.manageUrl).toMatch(/\/book\/manage\/[A-Za-z0-9_-]{43}$/);

      const reservation = await reservationFor(result.reference);

      expect(reservation).toMatchObject({ source: "ONLINE", createdByUserId: null, status: "CONFIRMED" });

      const [allergy] = await database().select().from(guestPartyAllergies).where(eq(guestPartyAllergies.guestPartyId, reservation.guestPartyId));

      expect(allergy).toMatchObject({ allergenId: list.PEANUTS.id, severity: "SEVERE", source: "ONLINE", recordedByUserId: null });

      const consents = await database().select().from(guestPartyMessageConsents).where(eq(guestPartyMessageConsents.guestPartyId, reservation.guestPartyId));

      expect(consents.map((row) => [row.channel, row.source, row.grantedByUserId]).sort()).toEqual([
        ["EMAIL", "ONLINE_FORM", null],
        ["SMS", "ONLINE_FORM", null],
      ]);

      const links = await database().select().from(reservationManageLinks).where(eq(reservationManageLinks.reservationId, reservation.id));

      // The reply's link, plus one in each queued message.
      expect(links).toHaveLength(3);
      expect(links.map((row) => row.tokenHash)).toContain(hashToken(tokenOf(result.manageUrl)));

      const messages = await database().select().from(guestMessages).where(eq(guestMessages.reservationId, reservation.id));

      expect(messages.map((row) => row.kind)).toEqual(["RESERVATION_CONFIRMED", "RESERVATION_CONFIRMED"]);

      const [audit] = await database()
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "reservations.online-booked"), eq(auditEvents.entityId, reservation.id)));

      expect(audit).toMatchObject({ actorType: "GUEST", actorUserId: null, category: "MESSAGING" });
      expect(JSON.stringify(audit)).not.toMatch(/5551234567|ana@example|Ana Online/);

      const [event] = await database().select().from(outboxEvents).where(eq(outboxEvents.aggregateId, reservation.id));

      expect(event).toMatchObject({ eventType: "reservation.online-booked", payload: { reservationId: reservation.id } });
      expect(JSON.stringify(event!.payload)).not.toContain("5551234567");

      // The host sees the booking, its allergy and its consent; nothing was linked to a profile.
      const [listed] = (await listReservations(database(), manager, { fromBusinessDate: date, toBusinessDate: date })).filter(
        (row) => row.id === reservation.id,
      );

      expect(listed).toMatchObject({ source: "ONLINE", messageConsent: { sms: true, email: true } });
      expect(listed!.guest.profile).toBeNull();
      expect(listed!.guest.allergies.map((row) => row.code)).toEqual(["PEANUTS"]);
    });

    it("holds bookings for approval when the location says so, and confirms them later", async () => {
      await enable({ requiresApproval: true });

      const result = await book();
      const reservation = await reservationFor(result.reference);

      expect(result.status).toBe("PENDING");
      expect((await database().select().from(guestMessages).where(eq(guestMessages.reservationId, reservation.id))).map((row) => row.kind)).toEqual([
        "RESERVATION_RECEIVED",
        "RESERVATION_RECEIVED",
      ]);

      await confirmReservation(database(), manager, reservation.id, { expectedVersion: reservation.version });

      const kinds = (await database().select().from(guestMessages).where(eq(guestMessages.reservationId, reservation.id))).map((row) => row.kind);

      expect(kinds.filter((kind) => kind === "RESERVATION_CONFIRMED")).toHaveLength(2);
    });

    it("returns the first booking for a retried request, with no second booking or message", async () => {
      const input = booking();
      const first = await createOnlineReservation(database(), code, input, guestContext);
      const second = await createOnlineReservation(database(), code, input, guestContext);

      expect(second.reference).toBe(first.reference);
      expect(second.manageUrl).not.toBe(first.manageUrl);

      const reservation = await reservationFor(first.reference);
      const all = await database().select().from(reservations).where(eq(reservations.locationId, scenario.locationA));

      expect(all).toHaveLength(1);
      expect(await database().select().from(guestMessages).where(eq(guestMessages.reservationId, reservation.id))).toHaveLength(2);
    });

    it("never lets two guests take the last covers of a slot", async () => {
      // 8 covers per slot: two parties of 5 can't both fit at 19:00.
      const results = await Promise.allSettled([
        book({ partySize: 5, phone: "(555) 200-0001", email: null, messageConsent: { sms: false, email: false } }),
        book({ partySize: 5, phone: "(555) 200-0002", email: null, messageConsent: { sms: false, email: false } }),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "SLOT_UNAVAILABLE" } });

      const { times } = await getPublicAvailability(database(), code, { localDate: date, partySize: 4 }, guestContext);

      expect(times).not.toContain("19:00");
    });

    it("refuses a party over the limit, a date outside the window and a time not offered", async () => {
      await expect(book({ partySize: 7 })).rejects.toMatchObject({ code: "PARTY_TOO_LARGE" });
      await expect(book({ localDate: addDays(date, 60) })).rejects.toMatchObject({ code: "OUTSIDE_BOOKING_WINDOW" });
      await expect(book({ localTime: "16:00" })).rejects.toMatchObject({ code: "SLOT_UNAVAILABLE" });
      await expect(book({ phone: null, email: null })).rejects.toMatchObject({ code: "CONTACT_REQUIRED" });
      await expect(book({ specialRequests: "card 4111111111111111" })).rejects.toMatchObject({ code: "LOOKS_LIKE_CARD_NUMBER" });
    });

    it("allows two upcoming online bookings per contact", async () => {
      const smsOnly = { email: null, messageConsent: { sms: true, email: false } };

      await book({ localTime: "17:00", ...smsOnly });
      await book({ localTime: "17:30", ...smsOnly });

      await expect(book({ localTime: "18:00", ...smsOnly })).rejects.toMatchObject({ code: "TOO_MANY_BOOKINGS" });
    });

    it("stores nothing when the spam trap is filled, but answers normally", async () => {
      const result = await book({ website: "http://spam.example" });

      expect(result.status).toBe("CONFIRMED");
      expect(await database().select().from(reservations).where(eq(reservations.locationId, scenario.locationA))).toEqual([]);
      expect(await database().select().from(guestParties).where(eq(guestParties.locationId, scenario.locationA))).toEqual([]);
    });

    it("throttles repeated attempts for one contact with a plain 429", async () => {
      const attempt = () => book({ partySize: 9, email: null, phone: "(555) 300-0000", messageConsent: { sms: true, email: false } }).catch((error: unknown) => error);

      for (let index = 0; index < 5; index += 1) {
        expect(await attempt()).toMatchObject({ code: "PARTY_TOO_LARGE" });
      }

      expect(await attempt()).toBeInstanceOf(TooManyRequestsError);
    });
  });

  describe("the manage link and opt-out (policies 4 and 11)", () => {
    it("shows and cancels a booking, frees its covers and tells the guest", async () => {
      const result = await book({ partySize: 6 });
      const token = tokenOf(result.manageUrl);

      expect(await getManagedReservation(database(), token, guestContext)).toMatchObject({
        reference: result.reference,
        partySize: 6,
        status: "CONFIRMED",
        canCancel: true,
      });
      expect((await getPublicAvailability(database(), code, { localDate: date, partySize: 4 }, guestContext)).times).not.toContain("19:00");

      expect(await cancelReservationByGuest(database(), token, guestContext)).toEqual({ cancelled: true });

      const reservation = await reservationFor(result.reference);

      expect(reservation).toMatchObject({ status: "CANCELLED", cancelledByGuest: true, cancelledByUserId: null });
      expect(await getManagedReservation(database(), token, guestContext)).toMatchObject({ status: "CANCELLED", canCancel: false });
      expect((await getPublicAvailability(database(), code, { localDate: date, partySize: 4 }, guestContext)).times).toContain("19:00");

      const messages = await database().select().from(guestMessages).where(eq(guestMessages.reservationId, reservation.id));

      expect(messages.filter((row) => row.kind === "RESERVATION_CANCELLED" && row.status === "QUEUED")).toHaveLength(2);
      expect(messages.filter((row) => row.kind === "RESERVATION_CONFIRMED").every((row) => row.status === "CANCELLED")).toBe(true);

      const [audit] = await database()
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "reservations.guest-cancelled"), eq(auditEvents.entityId, reservation.id)));

      expect(audit).toMatchObject({ actorType: "GUEST" });
      await expect(cancelReservationByGuest(database(), token, guestContext)).rejects.toMatchObject({ code: "GUEST_CANNOT_CANCEL" });
    });

    it("gives every bad token the same answer, and never stores the token", async () => {
      const result = await book();
      const token = tokenOf(result.manageUrl);

      expect(await getManagedReservation(database(), "A".repeat(43), guestContext)).toBeNull();
      expect(await getManagedReservation(database(), "short", guestContext)).toBeNull();
      await expect(cancelReservationByGuest(database(), "A".repeat(43), guestContext)).rejects.toMatchObject({ code: "INVALID_LINK" });

      const stored = JSON.stringify(await database().select().from(reservationManageLinks));

      expect(stored).not.toContain(token);
    });

    it("unsubscribes an email address with one click, for good", async () => {
      const result = await book({ messageConsent: { sms: false, email: true } });
      const reservation = await reservationFor(result.reference);
      const [email] = await database().select().from(guestMessages).where(eq(guestMessages.reservationId, reservation.id));
      const token = /\/messages\/unsubscribe\/([A-Za-z0-9_-]{43})/.exec(email!.body!)![1]!;

      expect(await unsubscribeByToken(database(), token)).toEqual({ done: true });
      expect(await unsubscribeByToken(database(), "nonsense")).toEqual({ done: true });

      const [after] = await database().select().from(guestMessages).where(eq(guestMessages.id, email!.id));

      expect(after!.status).toBe("CANCELLED");
      expect(
        await database().select().from(messageSuppressions).where(eq(messageSuppressions.organizationId, scenario.organizationId)),
      ).toHaveLength(1);

      const [consent] = await database()
        .select()
        .from(guestPartyMessageConsents)
        .where(eq(guestPartyMessageConsents.guestPartyId, reservation.guestPartyId));

      expect(consent).toMatchObject({ withdrawReason: "UNSUBSCRIBED" });
    });
  });
});
