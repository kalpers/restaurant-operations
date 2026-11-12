import { createHash, randomBytes } from "node:crypto";

import { and, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";

import { getMessagingConfig } from "@/config/messaging-env";
import type { Database } from "@/db";
import {
  guestMessages,
  guestParties,
  guestPartyMessageConsents,
  locations,
  locationSettings,
  onlineBookingSettings,
  reservationManageLinks,
  reservations,
  waitlistEntries,
  type GuestMessageKind,
  type GuestMessageStatus,
} from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import { enabledChannels } from "@/infrastructure/messaging";
import type { MessageChannel } from "@/infrastructure/messaging/message-sender";
import { recordAudit, type AuditInput } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

import { normalizeMessageAddress, toE164 } from "../rules/message-address";
import { renderGuestMessage } from "../rules/message-templates";
import { isReminderDue, reminderSendAfter } from "../rules/reminder-schedule";
import { actorHolds, assertAnyPermission, assertPermission } from "./guest-access";
import { addSuppression } from "./guest-message-dispatch";

// Phase 22 guest messaging (policies 2, 5, 13-16). Consent is recorded per visit and channel;
// messages are queued in the transaction of the change they report and only for channels with
// consent. Nothing here sends: the dispatcher does, after commit.

export type ConsentChoice = { sms: boolean; email: boolean };
export type ConsentState = Record<MessageChannel, { active: boolean; source: string | null; grantedAt: Date | null }>;

/** Who recorded a consent: staff at the host stand, or the guest on the online form. */
export type ConsentRecorder = { kind: "STAFF"; actor: Actor } | { kind: "GUEST"; organizationId: string; locationId: string };

const MANAGE_LINK_RETENTION_DAYS = 7;
const TABLE_READY_MIN_INTERVAL_MS = 60_000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** "+1•••••4567" or "a•••@example.com": enough to tell addresses apart, not to read one. */
export function maskAddress(channel: MessageChannel, address: string | null): string | null {
  if (!address) {
    return null;
  }

  if (channel === "SMS") {
    return `${address.slice(0, 2)}•••••${address.slice(-4)}`;
  }

  const [local, domain] = address.split("@");

  return `${(local ?? "").slice(0, 1)}•••@${domain ?? ""}`;
}

type LocationFacts = {
  organizationId: string;
  name: string;
  phone: string | null;
  timeZone: string;
  country: string;
  postGraceMinutes: number;
};

async function readLocationFacts(executor: DatabaseExecutor, locationId: string): Promise<LocationFacts> {
  const [row] = await executor
    .select({
      organizationId: locations.organizationId,
      name: locations.name,
      phone: locations.phone,
      timeZone: locations.timezone,
      country: locations.country,
      postGraceMinutes: locationSettings.reservationPostGraceMinutes,
    })
    .from(locations)
    .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
    .where(eq(locations.id, locationId));

  if (!row) {
    throw new NotFoundError("location");
  }

  return row;
}

/** The address each channel would use for this phone and email, or null when unusable. */
export function consentAddresses(
  contact: { phone: string | null; email: string | null },
  country: string,
): Record<MessageChannel, string | null> {
  return {
    SMS: toE164(contact.phone, country),
    EMAIL: contact.email ? normalizeMessageAddress("EMAIL", contact.email) : null,
  };
}

async function activeConsents(executor: DatabaseExecutor, guestPartyId: string) {
  return executor
    .select()
    .from(guestPartyMessageConsents)
    .where(and(eq(guestPartyMessageConsents.guestPartyId, guestPartyId), isNull(guestPartyMessageConsents.withdrawnAt)));
}

function recorderAudit(recorder: ConsentRecorder) {
  return recorder.kind === "STAFF" ? recorder.actor : null;
}

function recorderAuditActor(recorder: ConsentRecorder) {
  return recorder.kind === "STAFF"
    ? recorder.actor
    : { guest: true as const, organizationId: recorder.organizationId, locationId: recorder.locationId };
}

/** Withdraws one channel's active consent and cancels that channel's waiting messages. */
async function withdrawChannel(
  transaction: DatabaseTransaction,
  input: {
    guestPartyId: string;
    channel: MessageChannel;
    reason: "STAFF" | "ADDRESS_CHANGED" | "UNSUBSCRIBED" | "PROVIDER_OPT_OUT" | "ERASED";
    userId: string | null;
    now: Date;
  },
): Promise<boolean> {
  const withdrawn = await transaction
    .update(guestPartyMessageConsents)
    .set({ withdrawnAt: input.now, withdrawnByUserId: input.userId, withdrawReason: input.reason })
    .where(
      and(
        eq(guestPartyMessageConsents.guestPartyId, input.guestPartyId),
        eq(guestPartyMessageConsents.channel, input.channel),
        isNull(guestPartyMessageConsents.withdrawnAt),
      ),
    )
    .returning({ id: guestPartyMessageConsents.id });

  if (withdrawn.length > 0) {
    await cancelQueuedMessages(transaction, { guestPartyId: input.guestPartyId, channel: input.channel, now: input.now });
  }

  return withdrawn.length > 0;
}

/**
 * Brings a visit's consents in line with what the form says (policy 5). A ticked channel
 * needs a usable address: an E.164-able phone for SMS, a valid email for EMAIL. A changed
 * address withdraws that channel's consent first, so consent is never carried to a new
 * address. `choice` undefined means the form didn't touch consent: only address changes act.
 */
export async function reconcilePartyConsents(
  transaction: DatabaseTransaction,
  recorder: ConsentRecorder,
  input: {
    guestPartyId: string;
    locationId: string;
    contact: { phone: string | null; email: string | null };
    choice: ConsentChoice | undefined;
    now: Date;
  },
): Promise<void> {
  const facts = await readLocationFacts(transaction, input.locationId);
  const addresses = consentAddresses(input.contact, facts.country);
  const current = await activeConsents(transaction, input.guestPartyId);
  const actor = recorderAudit(recorder);
  const userId = actor?.userId ?? null;
  const audits: AuditInput[] = [];

  for (const channel of ["SMS", "EMAIL"] as const) {
    const wanted = input.choice ? (channel === "SMS" ? input.choice.sms : input.choice.email) : undefined;
    const existing = current.find((row) => row.channel === channel);
    const address = addresses[channel];

    if (wanted && !address) {
      throw new BusinessRuleError(
        channel === "SMS" ? "PHONE_NOT_TEXTABLE" : "EMAIL_NOT_USABLE",
        channel === "SMS"
          ? "Texts need a mobile number we can use: 10 digits, or a number starting with + and the country code."
          : "Emails need a valid email address.",
      );
    }

    const addressChanged = existing && existing.address !== address;
    const reason = addressChanged ? "ADDRESS_CHANGED" : wanted === false ? "STAFF" : null;

    if (existing && reason) {
      await withdrawChannel(transaction, { guestPartyId: input.guestPartyId, channel, reason, userId, now: input.now });
      audits.push({
        action: "messages.consent-withdrawn",
        entityId: input.guestPartyId,
        after: { guestPartyId: input.guestPartyId, channel, reason },
      });
    }

    const keep = existing && !reason;

    if (wanted && !keep) {
      await transaction.insert(guestPartyMessageConsents).values({
        guestPartyId: input.guestPartyId,
        channel,
        address: address!,
        grantedAt: input.now,
        source: recorder.kind === "STAFF" ? "STAFF_RECORDED" : "ONLINE_FORM",
        grantedByUserId: userId,
      });
      audits.push({
        action: "messages.consent-recorded",
        entityId: input.guestPartyId,
        after: { guestPartyId: input.guestPartyId, channel, source: recorder.kind === "STAFF" ? "STAFF_RECORDED" : "ONLINE_FORM" },
      });
    }
  }

  if (audits.length > 0) {
    await recordAudit(transaction, recorderAuditActor(recorder), audits);
  }
}

/** Which channels each visit has active consent for (host lists). Addresses aren't returned. */
export async function loadConsentFlags(
  executor: DatabaseExecutor,
  guestPartyIds: readonly string[],
): Promise<Map<string, ConsentChoice>> {
  const result = new Map<string, ConsentChoice>();

  if (guestPartyIds.length === 0) {
    return result;
  }

  const rows = await executor
    .select({ partyId: guestPartyMessageConsents.guestPartyId, channel: guestPartyMessageConsents.channel })
    .from(guestPartyMessageConsents)
    .where(
      and(
        inArray(guestPartyMessageConsents.guestPartyId, [...new Set(guestPartyIds)]),
        isNull(guestPartyMessageConsents.withdrawnAt),
      ),
    );

  for (const row of rows) {
    const flags = result.get(row.partyId) ?? { sms: false, email: false };

    result.set(row.partyId, { ...flags, [row.channel === "SMS" ? "sms" : "email"]: true });
  }

  return result;
}

/** Each channel's consent state for a visit. Addresses aren't returned. */
export async function getConsentState(executor: DatabaseExecutor, guestPartyId: string): Promise<ConsentState> {
  const rows = await activeConsents(executor, guestPartyId);
  const state = (channel: MessageChannel) => {
    const row = rows.find((consent) => consent.channel === channel);

    return { active: Boolean(row), source: row?.source ?? null, grantedAt: row?.grantedAt ?? null };
  };

  return { SMS: state("SMS"), EMAIL: state("EMAIL") };
}

/** Staff withdraw one channel's consent from the reservation or waitlist detail (policy 6). */
export async function withdrawConsentByStaff(
  database: Database,
  actor: Actor,
  guestPartyId: string,
  channel: MessageChannel,
): Promise<{ withdrawn: boolean }> {
  assertAnyPermission(actor, ["reservations.manage", "waitlist.manage"]);

  return withTransaction(database, async (transaction) => {
    const [party] = await transaction
      .select({ id: guestParties.id })
      .from(guestParties)
      .where(and(eq(guestParties.id, guestPartyId), eq(guestParties.locationId, actor.locationId)))
      .for("update");

    if (!party) {
      throw new NotFoundError("guest party");
    }

    const withdrawn = await withdrawChannel(transaction, {
      guestPartyId,
      channel,
      reason: "STAFF",
      userId: actor.userId,
      now: new Date(),
    });

    if (withdrawn) {
      await recordAudit(transaction, actor, {
        action: "messages.consent-withdrawn",
        entityId: guestPartyId,
        after: { guestPartyId, channel, reason: "STAFF" },
      });
    }

    return { withdrawn };
  });
}

/**
 * Cancels messages still waiting to send (QUEUED, or SENDING whose result will then not be
 * recorded), for a reservation, waitlist entry or party, optionally one channel or some kinds.
 */
export async function cancelQueuedMessages(
  executor: DatabaseExecutor,
  input: {
    reservationId?: string;
    waitlistEntryId?: string;
    guestPartyId?: string;
    channel?: MessageChannel;
    kinds?: readonly GuestMessageKind[];
    now: Date;
  },
): Promise<number> {
  const rows = await executor
    .update(guestMessages)
    .set({ status: "CANCELLED", cancelledAt: input.now, claimedAt: null })
    .where(
      and(
        inArray(guestMessages.status, ["QUEUED", "SENDING"]),
        input.reservationId ? eq(guestMessages.reservationId, input.reservationId) : undefined,
        input.waitlistEntryId ? eq(guestMessages.waitlistEntryId, input.waitlistEntryId) : undefined,
        input.guestPartyId ? eq(guestMessages.guestPartyId, input.guestPartyId) : undefined,
        input.channel ? eq(guestMessages.channel, input.channel) : undefined,
        input.kinds ? inArray(guestMessages.kind, [...input.kinds]) : undefined,
      ),
    )
    .returning({ id: guestMessages.id });

  return rows.length;
}

/** A new private link to a reservation. The token is returned once and never stored. */
export async function createManageLink(
  transaction: DatabaseTransaction,
  input: { reservationId: string; reservationAt: Date; now: Date },
): Promise<string> {
  const token = newToken();
  const base = Math.max(input.reservationAt.getTime(), input.now.getTime());

  await transaction.insert(reservationManageLinks).values({
    reservationId: input.reservationId,
    tokenHash: hashToken(token),
    expiresAt: new Date(base + MANAGE_LINK_RETENTION_DAYS * 86_400_000),
  });

  return token;
}

export function manageUrl(token: string, appBaseUrl: string = getMessagingConfig().appBaseUrl): string {
  return `${appBaseUrl}/book/manage/${token}`;
}

function unsubscribeUrl(token: string, appBaseUrl: string): string {
  return `${appBaseUrl}/messages/unsubscribe/${token}`;
}

type QueueTarget = {
  organizationId: string;
  locationId: string;
  guestPartyId: string;
  guestName: string;
  partySize: number;
  reservationId: string | null;
  waitlistEntryId: string | null;
  reservationAt: Date | null;
};

async function queueFor(
  transaction: DatabaseTransaction,
  target: QueueTarget,
  input: {
    kind: GuestMessageKind;
    /** What makes this trigger unique, e.g. the reservation version. */
    trigger: string;
    now: Date;
    sendAfter?: Date;
    /** Only the first channel with consent (table ready: SMS first). */
    firstChannelOnly?: boolean;
  },
): Promise<number> {
  const config = getMessagingConfig();
  const channels = enabledChannels(config);
  const consents = await activeConsents(transaction, target.guestPartyId);
  const facts = await readLocationFacts(transaction, target.locationId);
  const withLink = target.reservationId !== null && input.kind !== "RESERVATION_CANCELLED";
  let queued = 0;

  for (const channel of ["SMS", "EMAIL"] as const) {
    const consent = consents.find((row) => row.channel === channel);

    if (!consent?.address || !channels.includes(channel)) {
      continue;
    }

    const manageToken =
      withLink && target.reservationAt
        ? await createManageLink(transaction, {
            reservationId: target.reservationId!,
            reservationAt: target.reservationAt,
            now: input.now,
          })
        : null;
    const unsubscribeToken = channel === "EMAIL" ? newToken() : null;
    const rendered = renderGuestMessage({
      kind: input.kind,
      channel,
      locationName: facts.name,
      locationPhone: facts.phone,
      timeZone: facts.timeZone,
      at: target.reservationAt,
      partySize: target.partySize,
      guestName: target.guestName,
      manageUrl: manageToken ? manageUrl(manageToken, config.appBaseUrl) : null,
      unsubscribeUrl: unsubscribeToken ? unsubscribeUrl(unsubscribeToken, config.appBaseUrl) : null,
    });
    const subject = target.reservationId ? `reservation:${target.reservationId}` : `waitlist:${target.waitlistEntryId}`;
    const inserted = await transaction
      .insert(guestMessages)
      .values({
        organizationId: target.organizationId,
        locationId: target.locationId,
        guestPartyId: target.guestPartyId,
        reservationId: target.reservationId,
        waitlistEntryId: target.waitlistEntryId,
        kind: input.kind,
        channel,
        recipientAddress: consent.address,
        subject: rendered.subject,
        body: rendered.body,
        unsubscribeTokenHash: unsubscribeToken ? hashToken(unsubscribeToken) : null,
        dedupeKey: `${subject}:${input.kind}:${input.trigger}:${channel}`,
        sendAfter: input.sendAfter ?? input.now,
      })
      .onConflictDoNothing({ target: guestMessages.dedupeKey })
      .returning({ id: guestMessages.id });

    queued += inserted.length;

    if (input.firstChannelOnly) {
      break;
    }
  }

  return queued;
}

/** Queues a reservation message for each channel with consent (policy 13). */
export async function queueReservationMessage(
  transaction: DatabaseTransaction,
  input: { reservationId: string; kind: GuestMessageKind; trigger: string; now: Date; sendAfter?: Date },
): Promise<number> {
  const [row] = await transaction
    .select({
      reservationId: reservations.id,
      locationId: reservations.locationId,
      reservationAt: reservations.reservationAt,
      guestPartyId: guestParties.id,
      guestName: guestParties.guestName,
      partySize: guestParties.partySize,
      organizationId: locations.organizationId,
    })
    .from(reservations)
    .innerJoin(guestParties, eq(guestParties.id, reservations.guestPartyId))
    .innerJoin(locations, eq(locations.id, reservations.locationId))
    .where(eq(reservations.id, input.reservationId));

  if (!row) {
    throw new NotFoundError("reservation");
  }

  return queueFor(transaction, { ...row, waitlistEntryId: null }, input);
}

/**
 * Queues the table-ready message (policy 15): SMS when there is SMS consent, else email. A
 * second Notify within a minute queues nothing more.
 */
export async function queueTableReady(
  transaction: DatabaseTransaction,
  input: { waitlistEntryId: string; trigger: string; now: Date },
): Promise<number> {
  const [row] = await transaction
    .select({
      waitlistEntryId: waitlistEntries.id,
      locationId: waitlistEntries.locationId,
      guestPartyId: guestParties.id,
      guestName: guestParties.guestName,
      partySize: guestParties.partySize,
      organizationId: locations.organizationId,
    })
    .from(waitlistEntries)
    .innerJoin(guestParties, eq(guestParties.id, waitlistEntries.guestPartyId))
    .innerJoin(locations, eq(locations.id, waitlistEntries.locationId))
    .where(eq(waitlistEntries.id, input.waitlistEntryId));

  if (!row) {
    throw new NotFoundError("waitlist entry");
  }

  const [recent] = await transaction
    .select({ id: guestMessages.id })
    .from(guestMessages)
    .where(
      and(
        eq(guestMessages.waitlistEntryId, input.waitlistEntryId),
        eq(guestMessages.kind, "WAITLIST_TABLE_READY"),
        sql`${guestMessages.createdAt} > ${new Date(input.now.getTime() - TABLE_READY_MIN_INTERVAL_MS).toISOString()}::timestamptz`,
      ),
    )
    .limit(1);

  if (recent) {
    return 0;
  }

  return queueFor(
    transaction,
    { ...row, reservationId: null, reservationAt: null },
    { kind: "WAITLIST_TABLE_READY", trigger: input.trigger, now: input.now, firstChannelOnly: true },
  );
}

export type GuestMessageView = {
  id: string;
  kind: GuestMessageKind;
  channel: MessageChannel;
  status: GuestMessageStatus;
  /** Masked unless the viewer holds `guests.contact.view`; null once erased. */
  recipient: string | null;
  attempts: number;
  lastErrorCode: string | null;
  createdAt: Date;
  sentAt: Date | null;
  failedAt: Date | null;
};

/** Message history of a reservation or waitlist entry (policy 16). Bodies are never returned. */
export async function listGuestMessages(
  executor: DatabaseExecutor,
  actor: Actor,
  subject: { reservationId: string } | { waitlistEntryId: string },
): Promise<GuestMessageView[]> {
  assertPermission(actor, "messages.view");

  const showAddress = actorHolds(actor, "guests.contact.view");
  const rows = await executor
    .select({
      id: guestMessages.id,
      kind: guestMessages.kind,
      channel: guestMessages.channel,
      status: guestMessages.status,
      recipientAddress: guestMessages.recipientAddress,
      attempts: guestMessages.attempts,
      lastErrorCode: guestMessages.lastErrorCode,
      createdAt: guestMessages.createdAt,
      sentAt: guestMessages.sentAt,
      failedAt: guestMessages.failedAt,
    })
    .from(guestMessages)
    .where(
      and(
        eq(guestMessages.locationId, actor.locationId),
        "reservationId" in subject
          ? eq(guestMessages.reservationId, subject.reservationId)
          : eq(guestMessages.waitlistEntryId, subject.waitlistEntryId),
      ),
    )
    .orderBy(desc(guestMessages.createdAt));

  return rows.map(({ recipientAddress, ...row }) => {
    const channel = row.channel as MessageChannel;

    return {
      ...row,
      kind: row.kind as GuestMessageKind,
      channel,
      status: row.status as GuestMessageStatus,
      recipient: showAddress ? recipientAddress : maskAddress(channel, recipientAddress),
    };
  });
}

/** Requeues a FAILED message of this location (policy 16). */
export async function resendFailedMessage(
  database: Database,
  actor: Actor,
  messageId: string,
): Promise<{ id: string; status: "QUEUED" }> {
  assertPermission(actor, "messages.resend");

  return withTransaction(database, async (transaction) => {
    const [message] = await transaction
      .select({ id: guestMessages.id, status: guestMessages.status, kind: guestMessages.kind, channel: guestMessages.channel })
      .from(guestMessages)
      .where(and(eq(guestMessages.id, messageId), eq(guestMessages.locationId, actor.locationId)))
      .for("update");

    if (!message) {
      throw new NotFoundError("guest message");
    }

    if (message.status !== "FAILED") {
      throw new BusinessRuleError("MESSAGE_NOT_FAILED", "Only a failed message can be sent again.");
    }

    const now = new Date();

    await transaction
      .update(guestMessages)
      .set({ status: "QUEUED", failedAt: null, attempts: 0, nextAttemptAt: null, sendAfter: now })
      .where(eq(guestMessages.id, messageId));
    await recordAudit(transaction, actor, {
      action: "messages.resent",
      entityId: messageId,
      after: { kind: message.kind, channel: message.channel, mode: "RETRY_FAILED" },
    });

    return { id: messageId, status: "QUEUED" };
  });
}

/** Queues the confirmation again for a CONFIRMED reservation (policy 16). */
export async function resendConfirmation(
  database: Database,
  actor: Actor,
  reservationId: string,
): Promise<{ queued: number }> {
  assertPermission(actor, "messages.resend");

  return withTransaction(database, async (transaction) => {
    const [reservation] = await transaction
      .select({ id: reservations.id, status: reservations.status })
      .from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.locationId, actor.locationId)))
      .for("update");

    if (!reservation) {
      throw new NotFoundError("reservation");
    }

    if (reservation.status !== "CONFIRMED") {
      throw new BusinessRuleError("RESERVATION_NOT_CONFIRMED", "Only a confirmed reservation's confirmation can be sent again.");
    }

    const now = new Date();
    const queued = await queueReservationMessage(transaction, {
      reservationId,
      kind: "RESERVATION_CONFIRMED",
      trigger: `resend-${now.getTime()}`,
      now,
    });

    if (queued === 0) {
      throw new BusinessRuleError("NO_MESSAGE_CONSENT", "The guest hasn't agreed to texts or emails for this booking.");
    }

    await recordAudit(transaction, actor, {
      action: "messages.resent",
      entityId: reservationId,
      after: { kind: "RESERVATION_CONFIRMED", channel: null, mode: "CONFIRMATION" },
    });

    return { queued };
  });
}

/**
 * Sends the table-ready message again for a NOTIFIED entry (amendment 7): Notify itself can't
 * repeat, since NOTIFIED can't become NOTIFIED. At most once a minute.
 */
export async function resendTableReady(
  database: Database,
  actor: Actor,
  entryId: string,
): Promise<{ queued: number }> {
  assertPermission(actor, "messages.resend");

  return withTransaction(database, async (transaction) => {
    const [entry] = await transaction
      .select({ id: waitlistEntries.id, status: waitlistEntries.status })
      .from(waitlistEntries)
      .where(and(eq(waitlistEntries.id, entryId), eq(waitlistEntries.locationId, actor.locationId)))
      .for("update");

    if (!entry) {
      throw new NotFoundError("waitlist entry");
    }

    if (entry.status !== "NOTIFIED") {
      throw new BusinessRuleError("WAITLIST_NOT_NOTIFIED", "Press Notify first; a text can be sent again only after that.");
    }

    const now = new Date();
    const queued = await queueTableReady(transaction, { waitlistEntryId: entryId, trigger: `again-${now.getTime()}`, now });

    if (queued > 0) {
      await recordAudit(transaction, actor, {
        action: "messages.resent",
        entityId: entryId,
        after: { kind: "WAITLIST_TABLE_READY", channel: null, mode: "TABLE_READY_AGAIN" },
      });
    }

    return { queued };
  });
}

/** The longest reminder window a location can set (online_booking_settings CHECK). */
const MAX_REMINDER_HOURS = 168;
/** A location without settings reminds this many hours before (policy 7 default). */
export const DEFAULT_REMINDER_HOURS = 24;

/**
 * Queues the reminders that are due (policy 14), from the hourly maintenance run. Each
 * reservation time is reminded once (the dedupe key holds the time, so a moved booking is
 * reminded again for its new time). Quiet hours set `send_after`; a reminder that could only
 * go after the reservation starts is skipped.
 */
export async function queueDueReminders(database: Database, now: Date = new Date()): Promise<number> {
  const candidates = await database
    .select({
      reservationId: reservations.id,
      reservationAt: reservations.reservationAt,
      createdAt: reservations.createdAt,
      timeZone: locations.timezone,
      hoursBefore: sql<number>`COALESCE(${onlineBookingSettings.reminderHoursBefore}, ${DEFAULT_REMINDER_HOURS})`,
    })
    .from(reservations)
    .innerJoin(locations, eq(locations.id, reservations.locationId))
    .leftJoin(onlineBookingSettings, eq(onlineBookingSettings.locationId, reservations.locationId))
    .where(
      and(
        eq(reservations.status, "CONFIRMED"),
        gt(reservations.reservationAt, now),
        lte(reservations.reservationAt, new Date(now.getTime() + MAX_REMINDER_HOURS * 3_600_000)),
        sql`EXISTS (SELECT 1 FROM ${guestPartyMessageConsents}
          WHERE ${guestPartyMessageConsents.guestPartyId} = ${reservations.guestPartyId}
            AND ${guestPartyMessageConsents.withdrawnAt} IS NULL)`,
      ),
    );
  let queued = 0;

  for (const candidate of candidates) {
    if (!isReminderDue({ ...candidate, now })) {
      continue;
    }

    const sendAfter = reminderSendAfter(now, candidate.reservationAt, candidate.timeZone);

    if (!sendAfter) {
      continue;
    }

    queued += await withTransaction(database, async (transaction) => {
      // Re-read under a lock, so a booking cancelled meanwhile isn't reminded.
      const [current] = await transaction
        .select({ status: reservations.status, reservationAt: reservations.reservationAt })
        .from(reservations)
        .where(eq(reservations.id, candidate.reservationId))
        .for("update");

      if (current?.status !== "CONFIRMED" || current.reservationAt.getTime() !== candidate.reservationAt.getTime()) {
        return 0;
      }

      return queueReservationMessage(transaction, {
        reservationId: candidate.reservationId,
        kind: "RESERVATION_REMINDER",
        trigger: `at-${candidate.reservationAt.getTime()}`,
        now,
        sendAfter,
      });
    });
  }

  return queued;
}

/**
 * Erase (D14, policy 17), inside the caller's transaction: these visits' consents are
 * withdrawn and lose their addresses, their messages lose address, subject and body (unsent
 * ones are cancelled first), and their manage links stop working. Kinds, channels, statuses
 * and times stay. The opt-out list keeps its hashes.
 */
export async function eraseVisitMessaging(
  transaction: DatabaseTransaction,
  guestPartyIds: readonly string[],
  now: Date,
): Promise<void> {
  if (guestPartyIds.length === 0) {
    return;
  }

  const ids = [...guestPartyIds];

  await transaction
    .update(guestPartyMessageConsents)
    .set({ withdrawnAt: now, withdrawReason: "ERASED" })
    .where(and(inArray(guestPartyMessageConsents.guestPartyId, ids), isNull(guestPartyMessageConsents.withdrawnAt)));
  await transaction
    .update(guestPartyMessageConsents)
    .set({ address: null })
    .where(inArray(guestPartyMessageConsents.guestPartyId, ids));
  await transaction
    .update(guestMessages)
    .set({ status: "CANCELLED", cancelledAt: now, claimedAt: null })
    .where(and(inArray(guestMessages.guestPartyId, ids), inArray(guestMessages.status, ["QUEUED", "SENDING"])));
  await transaction
    .update(guestMessages)
    .set({ recipientAddress: null, subject: null, body: null, unsubscribeTokenHash: null, erasedAt: now })
    .where(and(inArray(guestMessages.guestPartyId, ids), isNull(guestMessages.erasedAt)));
  await transaction
    .update(reservationManageLinks)
    .set({ revokedAt: now })
    .where(
      and(
        isNull(reservationManageLinks.revokedAt),
        inArray(
          reservationManageLinks.reservationId,
          transaction.select({ id: reservations.id }).from(reservations).where(inArray(reservations.guestPartyId, ids)),
        ),
      ),
    );
}

/**
 * One-click email opt-out (D6, policy 4). Any token gets the same answer. A real one puts the
 * address on the opt-out list, withdraws the visit's email consent and cancels waiting emails.
 */
export async function unsubscribeByToken(database: Database, token: string): Promise<{ done: true }> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return { done: true };
  }

  await withTransaction(database, async (transaction) => {
    const [message] = await transaction
      .select({
        organizationId: guestMessages.organizationId,
        locationId: guestMessages.locationId,
        guestPartyId: guestMessages.guestPartyId,
        address: guestMessages.recipientAddress,
      })
      .from(guestMessages)
      .where(and(eq(guestMessages.unsubscribeTokenHash, hashToken(token)), eq(guestMessages.channel, "EMAIL")));

    if (!message) {
      return;
    }

    const now = new Date();

    if (message.address) {
      await addSuppression(transaction, {
        organizationId: message.organizationId,
        channel: "EMAIL",
        address: message.address,
        key: getMessagingConfig().suppressionKey,
        reason: "UNSUBSCRIBED",
      });
    }

    await withdrawChannel(transaction, {
      guestPartyId: message.guestPartyId,
      channel: "EMAIL",
      reason: "UNSUBSCRIBED",
      userId: null,
      now,
    });
    await recordAudit(
      transaction,
      { guest: true, organizationId: message.organizationId, locationId: message.locationId },
      {
        action: "messages.suppressed",
        entityId: message.guestPartyId,
        after: { guestPartyId: message.guestPartyId, channel: "EMAIL", reason: "UNSUBSCRIBED" },
      },
    );
  });

  return { done: true };
}
