import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  auditEvents,
  guestMessages,
  guestParties,
  guestPartyMessageConsents,
  messageSuppressions,
  reservationManageLinks,
  reservations,
  waitlistEntries,
} from "@/db/schema";
import { runMaintenance } from "@/infrastructure/maintenance/run-maintenance";
import { addSuppression } from "@/modules/reservations/services/guest-message-dispatch";
import { createGuestProfile, eraseGuestProfile, eraseGuestVisit } from "@/modules/reservations/services/guest-profile-service";
import { addDays, localDateOf, localToInstant } from "@/shared/time/zoned-time";
import type { Actor } from "@/modules/auth/types";
import { dispatchGuestMessages } from "@/modules/reservations/services/guest-message-dispatch";
import {
  getConsentState,
  hashToken,
  listGuestMessages,
  queueDueReminders,
  resendConfirmation,
  resendFailedMessage,
  resendTableReady,
  withdrawConsentByStaff,
} from "@/modules/reservations/services/guest-message-service";
import {
  cancelReservation,
  confirmReservation,
  markReservationNoShow,
  updateReservation,
} from "@/modules/reservations/services/reservation-service";
import { addToWaitlist, notifyWaitlistEntry, removeWaitlistEntry } from "@/modules/reservations/services/waitlist-service";
import { AuthorizationError, BusinessRuleError } from "@/shared/errors/app-error";
import { seatWaitlistParty } from "@/workflows/seat-guest-party/seat-guest-party";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import { localAt, RESERVATION_HOST_PERMISSIONS, reservationRow, reserve, TIME_ZONE } from "../../fixtures/reservation-fixtures";
import { createRestaurantScenario, tableFixture, type RestaurantScenario } from "../../fixtures/restaurant-fixtures";

// Phase 22 policies 2, 5, 6, 13, 15, 16, 19 and 20: consent, the messages staff actions queue,
// the history, resend and the audit trail. Messages use the capture adapter (both channels on).

const database = () => getDatabase();
const PHONE = "(555) 123-4567";
const E164 = "+15551234567";
const EMAIL = "Ana@Example.com";
const both = { sms: true, email: true };

describe("guest messaging from staff actions (Phase 22)", () => {
  let scenario: RestaurantScenario;
  let host: Actor;

  beforeEach(async () => {
    scenario = await createRestaurantScenario(database());
    host = await actorWith(database(), scenario, [
      ...RESERVATION_HOST_PERMISSIONS,
      "messages.view",
      "messages.resend",
      "guests.contact.view",
    ]);
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  const messagesOf = (where: { reservationId?: string; waitlistEntryId?: string }) =>
    database()
      .select()
      .from(guestMessages)
      .where(
        where.reservationId
          ? eq(guestMessages.reservationId, where.reservationId)
          : eq(guestMessages.waitlistEntryId, where.waitlistEntryId!),
      )
      .orderBy(guestMessages.createdAt);

  const book = (overrides: Parameters<typeof reserve>[3] = {}) =>
    reserve(database(), host, 24 * 60, { phone: PHONE, email: EMAIL, guestName: "Ana Guest", partySize: 4, messageConsent: both, ...overrides });

  describe("consent (policy 5)", () => {
    it("queues nothing without consent", async () => {
      const created = await book({ messageConsent: undefined });

      expect(await messagesOf({ reservationId: created.id })).toEqual([]);
    });

    it("records consent per channel with the normalized address and audits it without the address", async () => {
      const created = await book();
      const reservation = await reservationRow(database(), created.id);
      const consents = await database()
        .select()
        .from(guestPartyMessageConsents)
        .where(eq(guestPartyMessageConsents.guestPartyId, reservation.guestPartyId));

      expect(consents.map((row) => [row.channel, row.address, row.source, row.grantedByUserId]).sort()).toEqual([
        ["EMAIL", "ana@example.com", "STAFF_RECORDED", host.userId],
        ["SMS", E164, "STAFF_RECORDED", host.userId],
      ]);

      const audits = await database()
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "messages.consent-recorded"), eq(auditEvents.entityId, reservation.guestPartyId)));

      expect(audits).toHaveLength(2);
      expect(JSON.stringify(audits)).not.toMatch(/5551234567|ana@example/i);
    });

    it("refuses SMS consent for a number that can't be texted", async () => {
      await expect(book({ phone: "123-4567" })).rejects.toMatchObject({ code: "PHONE_NOT_TEXTABLE" });
      await expect(book({ email: null, messageConsent: { sms: false, email: true } })).rejects.toMatchObject({
        code: "EMAIL_NOT_USABLE",
      });
    });

    it("withdraws a channel when its address changes, and cancels what was waiting", async () => {
      const created = await book();
      const reservation = await reservationRow(database(), created.id);

      await updateReservation(database(), host, created.id, {
        expectedVersion: reservation.version,
        guestName: "Ana Guest",
        partySize: 4,
        phone: "(555) 999-0000",
        email: EMAIL,
        ...localAt(24 * 60),
        expectedDurationMinutes: 60,
      });

      const state = await getConsentState(database(), reservation.guestPartyId);

      expect(state.SMS.active).toBe(false);
      expect(state.EMAIL.active).toBe(true);

      const [withdrawn] = await database()
        .select()
        .from(guestPartyMessageConsents)
        .where(and(eq(guestPartyMessageConsents.guestPartyId, reservation.guestPartyId), eq(guestPartyMessageConsents.channel, "SMS")));

      expect(withdrawn).toMatchObject({ withdrawReason: "ADDRESS_CHANGED" });

      const sms = (await messagesOf({ reservationId: created.id })).filter((row) => row.channel === "SMS");

      expect(sms.map((row) => row.status)).toEqual(["CANCELLED"]);
    });

    it("lets staff withdraw a channel, which cancels its waiting messages", async () => {
      const created = await book();
      const reservation = await reservationRow(database(), created.id);

      expect(await withdrawConsentByStaff(database(), host, reservation.guestPartyId, "EMAIL")).toEqual({ withdrawn: true });
      expect(await withdrawConsentByStaff(database(), host, reservation.guestPartyId, "EMAIL")).toEqual({ withdrawn: false });

      const email = (await messagesOf({ reservationId: created.id })).filter((row) => row.channel === "EMAIL");

      expect(email.map((row) => row.status)).toEqual(["CANCELLED"]);
    });
  });

  describe("reservation messages (policy 13)", () => {
    it("queues one confirmation per channel, with a manage link and an email unsubscribe link", async () => {
      const created = await book();
      const messages = await messagesOf({ reservationId: created.id });

      expect(messages.map((row) => [row.kind, row.channel, row.status]).sort()).toEqual([
        ["RESERVATION_CONFIRMED", "EMAIL", "QUEUED"],
        ["RESERVATION_CONFIRMED", "SMS", "QUEUED"],
      ]);

      const sms = messages.find((row) => row.channel === "SMS")!;
      const email = messages.find((row) => row.channel === "EMAIL")!;

      expect(sms.recipientAddress).toBe(E164);
      expect(sms.body).toMatch(/^Fixture location: Your reservation for 4 guests on .+ is confirmed\. View or cancel: http.+\/book\/manage\/[A-Za-z0-9_-]{43} Reply STOP to opt out\.$/);
      expect(email.subject).toBe("Fixture location: Your reservation is confirmed");
      expect(email.body).toContain("Hi Ana Guest,");
      expect(email.body).toMatch(/\/messages\/unsubscribe\/[A-Za-z0-9_-]{43}/);

      // Only token hashes are stored.
      const token = /\/book\/manage\/([A-Za-z0-9_-]{43})/.exec(sms.body!)![1]!;
      const links = await database().select().from(reservationManageLinks).where(eq(reservationManageLinks.reservationId, created.id));

      expect(links.map((row) => row.tokenHash)).toContain(hashToken(token));
      expect(JSON.stringify(links)).not.toContain(token);
    });

    it("keeps notes and special requests out of every message", async () => {
      const created = await book({ notes: "Owner's friend", specialRequests: "Birthday, peanut allergy" });

      for (const row of await messagesOf({ reservationId: created.id })) {
        expect(row.body).not.toMatch(/friend|Birthday|peanut/);
      }
    });

    it("sends nothing for a tentative booking until it is confirmed", async () => {
      const created = await book({ status: "PENDING" });

      expect(await messagesOf({ reservationId: created.id })).toEqual([]);

      await confirmReservation(database(), host, created.id, { expectedVersion: created.version });

      expect((await messagesOf({ reservationId: created.id })).map((row) => row.kind)).toEqual([
        "RESERVATION_CONFIRMED",
        "RESERVATION_CONFIRMED",
      ]);
    });

    it("queues a change message only when the date, time or party size changes", async () => {
      const created = await book({ messageConsent: { sms: true, email: false } });
      const base = { guestName: "Ana Guest", phone: PHONE, email: EMAIL, expectedDurationMinutes: 60 };
      const notesOnly = await updateReservation(database(), host, created.id, {
        ...base,
        partySize: 4,
        ...localAt(24 * 60),
        notes: "Window",
        expectedVersion: created.version,
      });

      expect((await messagesOf({ reservationId: created.id })).map((row) => row.kind)).toEqual(["RESERVATION_CONFIRMED"]);

      await updateReservation(database(), host, created.id, { ...base, partySize: 6, ...localAt(24 * 60), expectedVersion: notesOnly.version });

      const kinds = (await messagesOf({ reservationId: created.id })).map((row) => row.kind);

      expect(kinds).toEqual(["RESERVATION_CONFIRMED", "RESERVATION_CHANGED"]);
      expect((await messagesOf({ reservationId: created.id }))[1]!.body).toContain("is now for 6 guests");
    });

    it("cancels waiting messages and tells the guest when cancelled, without a manage link", async () => {
      const created = await book({ messageConsent: { sms: true, email: false } });

      await cancelReservation(database(), host, created.id, { expectedVersion: created.version, reason: "Guest called" });

      const messages = await messagesOf({ reservationId: created.id });

      expect(messages.map((row) => [row.kind, row.status])).toEqual([
        ["RESERVATION_CONFIRMED", "CANCELLED"],
        ["RESERVATION_CANCELLED", "QUEUED"],
      ]);
      expect(messages[1]!.body).not.toContain("/book/manage/");
      expect(messages[1]!.body).not.toContain("Guest called");
    });

    it("cancels waiting messages on a no-show and sends nothing", async () => {
      const created = await reserve(database(), host, -60, { phone: PHONE, messageConsent: { sms: true, email: false } });

      await markReservationNoShow(database(), host, created.id, { expectedVersion: created.version });

      expect((await messagesOf({ reservationId: created.id })).map((row) => [row.kind, row.status])).toEqual([
        ["RESERVATION_CONFIRMED", "CANCELLED"],
      ]);
    });
  });

  describe("waitlist (policy 15)", () => {
    async function walkIn(consent?: { sms: boolean; email: boolean }) {
      const created = await addToWaitlist(database(), host, {
        guestName: "Walk In",
        partySize: 2,
        phone: PHONE,
        email: EMAIL,
        messageConsent: consent,
      });
      const [row] = await database().select().from(waitlistEntries).where(eq(waitlistEntries.id, created.id));

      return row!;
    }

    it("queues the table-ready text, SMS before email, and at most once a minute", async () => {
      const entry = await walkIn(both);
      const first = await notifyWaitlistEntry(database(), host, entry.id, { expectedVersion: entry.version });

      expect(first.messagesQueued).toBe(1);
      // Notify can't repeat (NOTIFIED can't become NOTIFIED); "Text again" can, once a minute.
      await expect(notifyWaitlistEntry(database(), host, entry.id, { expectedVersion: first.version })).rejects.toMatchObject({
        code: "INVALID_WAITLIST_TRANSITION",
      });
      expect(await resendTableReady(database(), host, entry.id)).toEqual({ queued: 0 });

      const waiting = await walkIn(both);

      await expect(resendTableReady(database(), host, waiting.id)).rejects.toMatchObject({ code: "WAITLIST_NOT_NOTIFIED" });

      const messages = await messagesOf({ waitlistEntryId: entry.id });

      expect(messages.map((row) => [row.kind, row.channel])).toEqual([["WAITLIST_TABLE_READY", "SMS"]]);
      expect(messages[0]!.body).toBe("Fixture location: Your table is ready. Please come to the host stand. Reply STOP to opt out.");
    });

    it("uses email when there is only email consent, and reports no consent as zero", async () => {
      const emailOnly = await walkIn({ sms: false, email: true });

      expect((await notifyWaitlistEntry(database(), host, emailOnly.id, { expectedVersion: emailOnly.version })).messagesQueued).toBe(1);
      expect((await messagesOf({ waitlistEntryId: emailOnly.id }))[0]!.channel).toBe("EMAIL");

      const none = await walkIn();

      expect((await notifyWaitlistEntry(database(), host, none.id, { expectedVersion: none.version })).messagesQueued).toBe(0);
    });

    it("cancels a waiting table-ready text when the party is seated or leaves", async () => {
      const seated = await walkIn(both);
      const notified = await notifyWaitlistEntry(database(), host, seated.id, { expectedVersion: seated.version });

      await seatWaitlistParty(database(), host, {
        entryId: seated.id,
        expectedVersion: notified.version,
        tableIds: [await tableFixture(database(), scenario)],
      });
      expect((await messagesOf({ waitlistEntryId: seated.id })).map((row) => row.status)).toEqual(["CANCELLED"]);

      const left = await walkIn(both);
      const leftNotified = await notifyWaitlistEntry(database(), host, left.id, { expectedVersion: left.version });

      await removeWaitlistEntry(database(), host, left.id, { expectedVersion: leftNotified.version, outcome: "LEFT" });
      expect((await messagesOf({ waitlistEntryId: left.id })).map((row) => row.status)).toEqual(["CANCELLED"]);
    });
  });

  describe("history and resend (policy 16)", () => {
    it("lists a reservation's messages without bodies, masking addresses without the contact permission", async () => {
      const created = await book();
      const full = await listGuestMessages(database(), host, { reservationId: created.id });

      expect(full).toHaveLength(2);
      expect(full.map((row) => row.recipient).sort()).toEqual([E164, "ana@example.com"]);
      expect(JSON.stringify(full)).not.toContain("View or cancel");

      const masked = await listGuestMessages(
        database(),
        await actorWith(database(), scenario, ["messages.view"]),
        { reservationId: created.id },
      );

      expect(masked.map((row) => row.recipient).sort()).toEqual(["+1•••••4567", "a•••@example.com"]);
      await expect(
        listGuestMessages(database(), await actorWith(database(), scenario, ["reservations.view"]), { reservationId: created.id }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("requeues a failed message and sends the confirmation again, auditing both", async () => {
      const created = await book({ messageConsent: { sms: true, email: false } });
      const sender = { name: "fails", send: async () => ({ ok: false as const, kind: "PERMANENT" as const, code: "twilio:400" }) };

      await dispatchGuestMessages(database(), { SMS: sender, EMAIL: null }, { maxAttempts: 3, suppressionKey: "k".repeat(64) });

      const [failed] = await messagesOf({ reservationId: created.id });

      expect(failed!.status).toBe("FAILED");
      expect(await resendFailedMessage(database(), host, failed!.id)).toEqual({ id: failed!.id, status: "QUEUED" });
      expect((await messagesOf({ reservationId: created.id }))[0]).toMatchObject({ status: "QUEUED", attempts: 0 });
      await expect(resendFailedMessage(database(), host, failed!.id)).rejects.toMatchObject({ code: "MESSAGE_NOT_FAILED" });

      expect(await resendConfirmation(database(), host, created.id)).toEqual({ queued: 1 });
      expect(await messagesOf({ reservationId: created.id })).toHaveLength(2);

      const audits = await database().select().from(auditEvents).where(eq(auditEvents.action, "messages.resent"));

      expect(audits.filter((row) => row.organizationId === scenario.organizationId)).toHaveLength(2);
    });

    it("refuses a confirmation resend without consent or permission", async () => {
      const created = await book({ messageConsent: undefined });

      await expect(resendConfirmation(database(), host, created.id)).rejects.toBeInstanceOf(BusinessRuleError);
      await expect(
        resendConfirmation(database(), await actorWith(database(), scenario, ["messages.view"]), created.id),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  describe("reminders (policy 14)", () => {
    /** A booking three days out at 19:00 local, made a week ago. */
    async function bookedEarly(consent = { sms: true, email: false }) {
      const localDate = addDays(localDateOf(new Date(), TIME_ZONE), 3);
      const created = await book({ localDate, localTime: "19:00", messageConsent: consent });

      await database()
        .update(reservations)
        .set({ createdAt: new Date(Date.now() - 7 * 86_400_000) })
        .where(eq(reservations.id, created.id));

      return { ...created, at: localToInstant(localDate, "19:00", TIME_ZONE)! };
    }

    const reminders = async (reservationId: string) =>
      (await messagesOf({ reservationId })).filter((row) => row.kind === "RESERVATION_REMINDER");

    it("queues one reminder per channel inside the window, once", async () => {
      const booking = await bookedEarly();
      const tenAm = new Date(booking.at.getTime() - 9 * 3_600_000);

      expect(await queueDueReminders(database(), new Date(booking.at.getTime() - 30 * 3_600_000))).toBe(0);
      expect(await queueDueReminders(database(), tenAm)).toBeGreaterThanOrEqual(1);
      expect(await queueDueReminders(database(), new Date(tenAm.getTime() + 3_600_000))).toBe(0);

      const [reminder] = await reminders(booking.id);

      expect(reminder).toMatchObject({ channel: "SMS", status: "QUEUED", sendAfter: tenAm });
      expect(reminder!.body).toContain("A reminder of your reservation for 4 guests");
    });

    it("delays a reminder due in quiet hours to 09:00", async () => {
      const booking = await bookedEarly();
      const elevenPm = new Date(booking.at.getTime() - 20 * 3_600_000);

      await queueDueReminders(database(), elevenPm);

      const [reminder] = await reminders(booking.id);

      expect(reminder!.sendAfter).toEqual(new Date(booking.at.getTime() - 10 * 3_600_000));
    });

    it("is cancelled with the booking, and reminds again for a new time", async () => {
      const booking = await bookedEarly();
      const tenAm = new Date(booking.at.getTime() - 9 * 3_600_000);

      await queueDueReminders(database(), tenAm);

      const row = await reservationRow(database(), booking.id);

      await cancelReservation(database(), host, booking.id, { expectedVersion: row.version });

      expect((await reminders(booking.id)).map((reminder) => reminder.status)).toEqual(["CANCELLED"]);
      expect(await queueDueReminders(database(), tenAm)).toBe(0);
    });

    it("skips bookings without consent", async () => {
      const booking = await bookedEarly({ sms: false, email: false });

      await queueDueReminders(database(), new Date(booking.at.getTime() - 9 * 3_600_000));

      expect(await reminders(booking.id)).toEqual([]);
    });
  });

  describe("erase and retention (policies 17 and 18)", () => {
    const eraser = () => actorWith(database(), scenario, [...RESERVATION_HOST_PERMISSIONS, "guests.erase", "guests.manage", "guests.view"]);

    async function erasedState(reservationId: string) {
      const reservation = await reservationRow(database(), reservationId);
      const consents = await database()
        .select()
        .from(guestPartyMessageConsents)
        .where(eq(guestPartyMessageConsents.guestPartyId, reservation.guestPartyId));
      const messages = await messagesOf({ reservationId });
      const links = await database().select().from(reservationManageLinks).where(eq(reservationManageLinks.reservationId, reservationId));

      return { consents, messages, links };
    }

    it("erasing a profile clears its visits' consents, message content and manage links, keeping statuses", async () => {
      const manager = await eraser();
      const profile = await createGuestProfile(database(), manager, {
        displayName: "Ana Guest",
        phone: PHONE,
        email: EMAIL,
        vip: false,
        vipReason: null,
        preferences: null,
        notes: null,
        otherDietaryNeeds: null,
      });
      const created = await reserve(database(), manager, 24 * 60, {
        guestName: "Ana Guest",
        phone: PHONE,
        email: EMAIL,
        messageConsent: both,
        guestProfileId: profile.id,
      });
      const sender = { name: "ok", send: async () => ({ ok: true as const, providerMessageId: "p" }) };

      // One sent (SMS), one still waiting (email channel off for this pass).
      await dispatchGuestMessages(database(), { SMS: sender, EMAIL: null }, { maxAttempts: 3, suppressionKey: "k".repeat(64) });
      await addSuppression(database(), { organizationId: scenario.organizationId, channel: "SMS", address: E164, key: "k".repeat(64), reason: "STAFF" });

      await eraseGuestProfile(database(), manager, { profileId: profile.id, expectedVersion: profile.version, reason: "Guest asked" });

      const { consents, messages, links } = await erasedState(created.id);

      expect(consents.every((row) => row.address === null && row.withdrawReason === "ERASED")).toBe(true);
      expect(messages.map((row) => [row.channel, row.status, row.recipientAddress, row.body]).sort()).toEqual([
        ["EMAIL", "CANCELLED", null, null],
        ["SMS", "SENT", null, null],
      ]);
      expect(messages.every((row) => row.erasedAt !== null)).toBe(true);
      expect(links.every((row) => row.revokedAt !== null)).toBe(true);
      // The opt-out list keeps only its hash, and keeps it.
      expect(
        await database().select().from(messageSuppressions).where(eq(messageSuppressions.organizationId, scenario.organizationId)),
      ).toHaveLength(1);
    });

    it("erases one unlinked visit, and refuses a linked one", async () => {
      const manager = await eraser();
      const created = await book();
      const reservation = await reservationRow(database(), created.id);
      const [party] = await database().select().from(guestParties).where(eq(guestParties.id, reservation.guestPartyId));

      expect(await eraseGuestVisit(database(), manager, { guestPartyId: party!.id, expectedVersion: party!.version, reason: "Request" })).toEqual({
        id: party!.id,
        erased: true,
      });

      const [after] = await database().select().from(guestParties).where(eq(guestParties.id, party!.id));

      expect(after).toMatchObject({ guestName: "Erased guest", phone: null, email: null, specialRequests: null });

      const { consents, messages } = await erasedState(created.id);

      expect(consents.every((row) => row.address === null)).toBe(true);
      expect(messages.every((row) => row.body === null && row.status === "CANCELLED")).toBe(true);
      expect((await reservationRow(database(), created.id)).status).toBe("CONFIRMED");

      const audits = await database()
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "guests.visit-erased"), eq(auditEvents.entityId, party!.id)));

      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits)).not.toMatch(/5551234567|ana@example/i);

      const profile = await createGuestProfile(database(), manager, {
        displayName: "Ben",
        phone: null,
        email: null,
        vip: false,
        vipReason: null,
        preferences: null,
        notes: null,
        otherDietaryNeeds: null,
      });
      const linked = await reserve(database(), manager, 24 * 60, { guestProfileId: profile.id });
      const linkedRow = await reservationRow(database(), linked.id);
      const [linkedParty] = await database().select().from(guestParties).where(eq(guestParties.id, linkedRow.guestPartyId));

      await expect(
        eraseGuestVisit(database(), manager, { guestPartyId: linkedParty!.id, expectedVersion: linkedParty!.version, reason: "x" }),
      ).rejects.toMatchObject({ code: "PARTY_HAS_PROFILE" });
      await expect(
        eraseGuestVisit(database(), host, { guestPartyId: linkedParty!.id, expectedVersion: linkedParty!.version, reason: "x" }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("retention clears old finished messages and leaves waiting ones", async () => {
      const created = await book({ messageConsent: { sms: true, email: false } });
      const sender = { name: "ok", send: async () => ({ ok: true as const, providerMessageId: "p" }) };

      await dispatchGuestMessages(database(), { SMS: sender, EMAIL: null }, { maxAttempts: 3, suppressionKey: "k".repeat(64) });

      const waiting = await book({ messageConsent: { sms: true, email: false } });
      const result = await runMaintenance(database(), new Date(), { messageRetentionDays: 0, notify: false });

      expect(result).toMatchObject({ skipped: false });

      const [sent] = await messagesOf({ reservationId: created.id });
      const [queued] = await messagesOf({ reservationId: waiting.id });

      expect(sent).toMatchObject({ status: "SENT", recipientAddress: null, body: null });
      expect(sent!.erasedAt).not.toBeNull();
      expect(queued).toMatchObject({ status: "QUEUED", recipientAddress: E164 });
    });
  });
});
