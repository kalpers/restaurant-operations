import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { guestMessages, messageSuppressions, waitlistEntries } from "@/db/schema";
import type { MessageSender, OutboundMessage, SendResult } from "@/infrastructure/messaging/message-sender";
import type { Actor } from "@/modules/auth/types";
import { suppressionHash } from "@/modules/reservations/rules/message-address";
import { STALE_SENDING_MS } from "@/modules/reservations/rules/message-dispatch-policy";
import {
  addSuppression,
  dispatchGuestMessages,
  type DispatchSenders,
} from "@/modules/reservations/services/guest-message-dispatch";
import { addToWaitlist } from "@/modules/reservations/services/waitlist-service";

import { clearEmployeeData } from "../../fixtures/employee-fixtures";
import { reservationHost } from "../../fixtures/reservation-fixtures";
import { createRestaurantScenario, type RestaurantScenario } from "../../fixtures/restaurant-fixtures";

// Phase 22 policies 2-4: the message outbox, the dispatcher, the opt-out list and their guards.

const database = () => getDatabase();
const KEY = "k".repeat(64);
const PHONE = "+15551234567";

/** A sender that records what it was asked to send and answers from a script. */
function scripted(results: SendResult[] = [], onSend?: (message: OutboundMessage) => Promise<void>) {
  const sent: OutboundMessage[] = [];
  const sender: MessageSender = {
    name: "scripted",
    async send(message) {
      sent.push(message);
      await onSend?.(message);

      return results.shift() ?? { ok: true, providerMessageId: `prov-${sent.length}` };
    },
  };

  return { sender, sent };
}

describe("guest message dispatch (Phase 22)", () => {
  let scenario: RestaurantScenario;
  let host: Actor;
  let entry: { id: string; guestPartyId: string };

  beforeEach(async () => {
    scenario = await createRestaurantScenario(database());
    host = await reservationHost(database(), scenario);

    const created = await addToWaitlist(database(), host, { guestName: "Ana Guest", partySize: 2, phone: "555-123-4567" });
    const [row] = await database().select().from(waitlistEntries).where(eq(waitlistEntries.id, created.id));

    entry = { id: row!.id, guestPartyId: row!.guestPartyId };
  });

  afterAll(async () => {
    await clearEmployeeData(database());
    await closeDatabase();
  });

  async function queue(overrides: Partial<typeof guestMessages.$inferInsert> = {}) {
    const [row] = await database()
      .insert(guestMessages)
      .values({
        organizationId: scenario.organizationId,
        locationId: host.locationId,
        guestPartyId: entry.guestPartyId,
        waitlistEntryId: entry.id,
        kind: "WAITLIST_TABLE_READY",
        channel: "SMS",
        recipientAddress: PHONE,
        body: "Your table is ready.",
        dedupeKey: `test:${randomUUID()}`,
        sendAfter: new Date(Date.now() - 1000),
        ...overrides,
      })
      .returning();

    return row!;
  }

  async function row(id: string) {
    const [found] = await database().select().from(guestMessages).where(eq(guestMessages.id, id));

    return found!;
  }

  const senders = (sms: MessageSender | null, email: MessageSender | null = null): DispatchSenders => ({ SMS: sms, EMAIL: email });
  const dispatch = (s: DispatchSenders, now = new Date(), maxAttempts = 3) =>
    dispatchGuestMessages(database(), s, { now, maxAttempts, suppressionKey: KEY });

  it("sends a due message once and records the provider ID", async () => {
    const message = await queue();
    const { sender, sent } = scripted();

    expect(await dispatch(senders(sender))).toMatchObject({ sent: 1 });
    expect(await dispatch(senders(sender))).toMatchObject({ sent: 0 });
    expect(sent).toEqual([{ id: message.id, channel: "SMS", to: PHONE, subject: null, body: "Your table is ready." }]);
    expect(await row(message.id)).toMatchObject({ status: "SENT", attempts: 1, providerMessageId: "prov-1", claimedAt: null });
  });

  it("commits the claim before the provider is called, so no transaction is open during the send", async () => {
    const message = await queue();
    let seenFromAnotherConnection: string | undefined;
    const { sender } = scripted([], async () => {
      // A fresh connection only sees committed data.
      const reserved = await (database() as unknown as { $client: import("postgres").Sql }).$client.reserve();

      try {
        const [found] = await reserved<{ status: string; in_tx: boolean }[]>`
          SELECT status FROM guest_messages WHERE id = ${message.id}`;

        seenFromAnotherConnection = found?.status;
      } finally {
        reserved.release();
      }
    });

    await dispatch(senders(sender));

    expect(seenFromAnotherConnection).toBe("SENDING");
  });

  it("does not claim a message before its send-after time", async () => {
    const message = await queue({ sendAfter: new Date(Date.now() + 60_000) });
    const { sender, sent } = scripted();

    await dispatch(senders(sender));

    expect(sent).toHaveLength(0);
    expect((await row(message.id)).status).toBe("QUEUED");
  });

  it("backs off a transient failure and fails it at the maximum attempts", async () => {
    const message = await queue();
    const transient: SendResult = { ok: false, kind: "TRANSIENT", code: "twilio:503" };
    const { sender, sent } = scripted([transient, transient, transient]);
    const start = new Date();

    expect(await dispatch(senders(sender), start)).toMatchObject({ retried: 1 });

    const afterFirst = await row(message.id);

    expect(afterFirst).toMatchObject({ status: "QUEUED", attempts: 1, lastErrorCode: "twilio:503" });
    expect(afterFirst.nextAttemptAt!.getTime() - start.getTime()).toBe(5_000);

    // Not due yet.
    await dispatch(senders(sender), new Date(start.getTime() + 1_000));
    expect(sent).toHaveLength(1);

    await dispatch(senders(sender), new Date(start.getTime() + 6_000));
    expect(await dispatch(senders(sender), new Date(start.getTime() + 60_000))).toMatchObject({ failed: 1 });
    expect(await row(message.id)).toMatchObject({ status: "FAILED", attempts: 3, nextAttemptAt: null });
  });

  it("fails a permanent failure at once", async () => {
    const message = await queue();
    const { sender } = scripted([{ ok: false, kind: "PERMANENT", code: "twilio:400:21211" }]);

    expect(await dispatch(senders(sender))).toMatchObject({ failed: 1 });
    expect(await row(message.id)).toMatchObject({ status: "FAILED", attempts: 1 });
  });

  it("records a provider opt-out as a suppression and never sends to that address again", async () => {
    const first = await queue();
    const { sender, sent } = scripted([{ ok: false, kind: "OPTED_OUT", code: "twilio:400:21610" }]);

    expect(await dispatch(senders(sender))).toMatchObject({ suppressed: 1 });
    expect(await row(first.id)).toMatchObject({ status: "SUPPRESSED" });

    const suppressions = await database()
      .select()
      .from(messageSuppressions)
      .where(eq(messageSuppressions.organizationId, scenario.organizationId));

    expect(suppressions).toEqual([
      expect.objectContaining({ channel: "SMS", reason: "PROVIDER_OPT_OUT", addressHash: suppressionHash(KEY, "SMS", PHONE) }),
    ]);
    expect(JSON.stringify(suppressions)).not.toContain("5551234567");

    const second = await queue();

    expect(await dispatch(senders(sender))).toMatchObject({ suppressed: 1, sent: 0 });
    expect(sent).toHaveLength(1);
    expect(await row(second.id)).toMatchObject({ status: "SUPPRESSED", attempts: 0 });
  });

  it("checks the opt-out list per organization, channel and normalized address", async () => {
    await addSuppression(database(), { organizationId: scenario.organizationId, channel: "EMAIL", address: " Ana@Example.com ", key: KEY, reason: "UNSUBSCRIBED" });
    await addSuppression(database(), { organizationId: scenario.organizationId, channel: "EMAIL", address: "ana@example.com", key: KEY, reason: "STAFF" });

    const email = await queue({ channel: "EMAIL", recipientAddress: "ANA@example.com", subject: "Table ready" });
    const sms = await queue();
    const { sender, sent } = scripted();

    expect(await dispatch(senders(sender, sender))).toMatchObject({ sent: 1, suppressed: 1 });
    expect((await row(email.id)).status).toBe("SUPPRESSED");
    expect((await row(sms.id)).status).toBe("SENT");
    expect(sent.map((message) => message.channel)).toEqual(["SMS"]);
    // Adding the same address twice keeps one row.
    expect(
      await database().select().from(messageSuppressions).where(eq(messageSuppressions.organizationId, scenario.organizationId)),
    ).toHaveLength(1);
  });

  it("cancels a message whose channel was turned off", async () => {
    const message = await queue();

    expect(await dispatch(senders(null))).toMatchObject({ cancelled: 1 });
    expect(await row(message.id)).toMatchObject({ status: "CANCELLED", lastErrorCode: "channel-off" });
  });

  it("recovers a send left SENDING by a crashed process", async () => {
    const message = await queue();
    const crashedAt = new Date(Date.now() - STALE_SENDING_MS - 1_000);

    await database().update(guestMessages).set({ status: "SENDING", claimedAt: crashedAt }).where(eq(guestMessages.id, message.id));

    const { sender } = scripted();

    expect(await dispatch(senders(sender))).toMatchObject({ recovered: 1, sent: 1 });
    expect((await row(message.id)).status).toBe("SENT");
  });

  it("never overwrites a message cancelled while it was being sent", async () => {
    const message = await queue();
    const { sender } = scripted([], async () => {
      await database()
        .update(guestMessages)
        .set({ status: "CANCELLED", cancelledAt: new Date(), claimedAt: null })
        .where(eq(guestMessages.id, message.id));
    });

    await dispatch(senders(sender));

    expect(await row(message.id)).toMatchObject({ status: "CANCELLED", sentAt: null });
  });

  describe("guards (policy 2)", () => {
    const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { cause?: { constraint_name?: string } }).cause?.constraint_name ?? String(error));

    it("refuses deletes, identity changes and new content", async () => {
      const message = await queue();

      expect(await refusal(database().delete(guestMessages).where(eq(guestMessages.id, message.id)))).toBe("guest_messages_no_delete");
      expect(await refusal(database().update(guestMessages).set({ kind: "RESERVATION_CHANGED" }).where(eq(guestMessages.id, message.id)))).not.toBeNull();
      expect(await refusal(database().update(guestMessages).set({ body: "Something else" }).where(eq(guestMessages.id, message.id)))).toBe(
        "guest_messages_content_frozen",
      );
    });

    it("allows content to be cleared only with the erase mark, and keeps a sent message final", async () => {
      const message = await queue();
      const { sender } = scripted();

      await dispatch(senders(sender));

      expect(
        await refusal(database().update(guestMessages).set({ recipientAddress: null }).where(eq(guestMessages.id, message.id))),
      ).toBe("guest_messages_content");
      await database()
        .update(guestMessages)
        .set({ recipientAddress: null, subject: null, body: null, erasedAt: new Date() })
        .where(eq(guestMessages.id, message.id));
      expect(await refusal(database().update(guestMessages).set({ status: "QUEUED", sentAt: null }).where(eq(guestMessages.id, message.id)))).toBe(
        "guest_messages_status_transition",
      );
      expect(await refusal(database().update(guestMessages).set({ attempts: 5 }).where(eq(guestMessages.id, message.id)))).toBe(
        "guest_messages_final",
      );
    });

    it("refuses a second message for the same trigger", async () => {
      await queue({ dedupeKey: "same-trigger" });

      expect(await refusal(queue({ dedupeKey: "same-trigger" }))).toBe("guest_messages_dedupe_key_unique");
    });

    it("keeps the opt-out list append-only", async () => {
      await addSuppression(database(), { organizationId: scenario.organizationId, channel: "SMS", address: PHONE, key: KEY, reason: "STAFF" });

      expect(await refusal(database().execute(sql`DELETE FROM message_suppressions`))).toBe("message_suppressions_append_only");
    });
  });
});
