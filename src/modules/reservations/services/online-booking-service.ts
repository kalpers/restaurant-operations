import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";

import { getPublicBookingConfig } from "@/config/messaging-env";
import type { Database } from "@/db";
import { nextVersion } from "@/db/helpers/versioning";
import {
  allergens,
  guestParties,
  guestPartyAllergies,
  locations,
  locationSettings,
  onlineBookingPeriods,
  onlineBookingSettings,
  reservationManageLinks,
  reservations,
} from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { BusinessRuleError, ConflictError, TooManyRequestsError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { businessDateOf } from "@/shared/time/business-date-service";
import { addDays, localDateOf, localMinutesOf, localTimeOf, localToInstantLenient } from "@/shared/time/zoned-time";

import { appendPartyHistory, changePartyStatus, lockPartyGraph } from "../repositories/party-repository";
import { countPublicAttempt, publicThrottleKey } from "../repositories/public-throttle-repository";
import { endAssignments, readReservationContext } from "../repositories/reservation-repository";
import { assertNoCardNumbers } from "../rules/guest-contact";
import { assertReservationTransition } from "../rules/lifecycle";
import { normalizeMessageAddress, toE164 } from "../rules/message-address";
import { formatMessageTime } from "../rules/message-templates";
import { findPeriodProblem, listOfferedSlots, slotKey, type BookingPeriod, type SlotSettings } from "../rules/online-slots";
import type { ReservationStatus } from "../types";
import { assertPermission } from "./guest-access";
import {
  cancelQueuedMessages,
  createManageLink,
  hashToken,
  manageUrl,
  queueReservationMessage,
  reconcilePartyConsents,
  type ConsentChoice,
} from "./guest-message-service";

// Phase 22 online booking (policies 7-12). The public commands act as a GUEST: no user, no
// permissions, one location. They answer with plain refusals that reveal nothing about other
// bookings, tables or staff.

export const ONLINE_BOOKING_DEFAULTS = {
  enabled: false,
  requiresApproval: false,
  maxPartySize: 6,
  minLeadMinutes: 120,
  maxDaysAhead: 30,
  slotIntervalMinutes: 15,
  maxCoversPerSlot: 20,
  reminderHoursBefore: 24,
  publicNote: null as string | null,
};

/** Upcoming online bookings one phone or email may hold at a location (D7). */
export const MAX_UPCOMING_ONLINE_PER_CONTACT = 2;
const ACTIVE_STATUSES: readonly ReservationStatus[] = ["PENDING", "CONFIRMED", "CHECKED_IN"];
const CLOSED_MESSAGE = "Online booking isn't available for this restaurant.";

export type OnlineBookingSettingsInput = Omit<typeof ONLINE_BOOKING_DEFAULTS, "publicNote"> & { publicNote: string | null };
export type OnlineBookingSettingsView = OnlineBookingSettingsInput & { version: number | null; periods: BookingPeriod[] };

// ---------------------------------------------------------------------------------------------
// Settings (staff, `reservations.online.manage`)
// ---------------------------------------------------------------------------------------------

async function readSettings(executor: DatabaseExecutor, locationId: string) {
  const [row] = await executor.select().from(onlineBookingSettings).where(eq(onlineBookingSettings.locationId, locationId));
  const periods = await executor
    .select({ weekday: onlineBookingPeriods.weekday, startsAt: onlineBookingPeriods.startsAt, endsAt: onlineBookingPeriods.endsAt })
    .from(onlineBookingPeriods)
    .where(eq(onlineBookingPeriods.locationId, locationId))
    .orderBy(asc(onlineBookingPeriods.weekday), asc(onlineBookingPeriods.startsAt));

  return { row, periods: periods.map((period) => ({ ...period, startsAt: period.startsAt.slice(0, 5), endsAt: period.endsAt.slice(0, 5) })) };
}

export async function getOnlineBookingSettings(executor: DatabaseExecutor, actor: Actor): Promise<OnlineBookingSettingsView> {
  assertPermission(actor, "reservations.online.manage");

  const { row, periods } = await readSettings(executor, actor.locationId);
  const source = row ?? ONLINE_BOOKING_DEFAULTS;

  return {
    enabled: source.enabled,
    requiresApproval: source.requiresApproval,
    maxPartySize: source.maxPartySize,
    minLeadMinutes: source.minLeadMinutes,
    maxDaysAhead: source.maxDaysAhead,
    slotIntervalMinutes: source.slotIntervalMinutes,
    maxCoversPerSlot: source.maxCoversPerSlot,
    reminderHoursBefore: source.reminderHoursBefore,
    publicNote: source.publicNote,
    version: row?.version ?? null,
    periods,
  };
}

/** Saves the settings (policy 7). `expectedVersion` is null for the first save. */
export async function saveOnlineBookingSettings(
  database: Database,
  actor: Actor,
  input: OnlineBookingSettingsInput & { expectedVersion: number | null },
): Promise<{ version: number }> {
  assertPermission(actor, "reservations.online.manage");
  assertNoCardNumbers({ publicNote: input.publicNote });

  return withTransaction(database, async (transaction) => {
    const [current] = await transaction
      .select()
      .from(onlineBookingSettings)
      .where(eq(onlineBookingSettings.locationId, actor.locationId))
      .for("update");

    if ((current?.version ?? null) !== input.expectedVersion) {
      throw new ConcurrencyError("online booking settings", current?.id ?? actor.locationId);
    }

    const values: OnlineBookingSettingsInput = {
      enabled: input.enabled,
      requiresApproval: input.requiresApproval,
      maxPartySize: input.maxPartySize,
      minLeadMinutes: input.minLeadMinutes,
      maxDaysAhead: input.maxDaysAhead,
      slotIntervalMinutes: input.slotIntervalMinutes,
      maxCoversPerSlot: input.maxCoversPerSlot,
      reminderHoursBefore: input.reminderHoursBefore,
      publicNote: input.publicNote,
    };
    const publicNote = values.publicNote?.trim() || null;
    const changed = (Object.keys(values) as (keyof OnlineBookingSettingsInput)[]).filter(
      (key) => (current ?? ONLINE_BOOKING_DEFAULTS)[key] !== (key === "publicNote" ? publicNote : values[key]),
    );
    const [saved] = current
      ? await transaction
          .update(onlineBookingSettings)
          .set({ ...values, publicNote, updatedByUserId: actor.userId, version: nextVersion(onlineBookingSettings.version) })
          .where(eq(onlineBookingSettings.id, current.id))
          .returning({ version: onlineBookingSettings.version })
      : await transaction
          .insert(onlineBookingSettings)
          .values({ ...values, publicNote, locationId: actor.locationId, updatedByUserId: actor.userId })
          .returning({ version: onlineBookingSettings.version });

    await recordAudit(transaction, actor, {
      action: "reservations.online-settings-changed",
      entityId: actor.locationId,
      after: { changedFields: changed, enabled: values.enabled },
    });

    return { version: saved!.version };
  });
}

/** Replaces the location's booking hours (policy 7). */
export async function replaceBookingPeriods(
  database: Database,
  actor: Actor,
  periods: readonly BookingPeriod[],
): Promise<{ periods: number }> {
  assertPermission(actor, "reservations.online.manage");

  const problem = findPeriodProblem(periods);

  if (problem) {
    throw new BusinessRuleError("INVALID_BOOKING_HOURS", problem);
  }

  return withTransaction(database, async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`online-booking:${actor.locationId}`}, 0))`);
    await transaction.delete(onlineBookingPeriods).where(eq(onlineBookingPeriods.locationId, actor.locationId));

    if (periods.length > 0) {
      await transaction
        .insert(onlineBookingPeriods)
        .values(periods.map((period) => ({ ...period, locationId: actor.locationId })));
    }

    await recordAudit(transaction, actor, {
      action: "reservations.booking-hours-changed",
      entityId: actor.locationId,
      after: { periodCount: periods.length, weekdays: [...new Set(periods.map((period) => period.weekday))].sort() },
    });

    return { periods: periods.length };
  });
}

// ---------------------------------------------------------------------------------------------
// The public page (a GUEST, no user)
// ---------------------------------------------------------------------------------------------

export type PublicLocation = {
  locationId: string;
  organizationId: string;
  code: string;
  name: string;
  phone: string | null;
  timeZone: string;
  country: string;
  settings: SlotSettings & { requiresApproval: boolean; publicNote: string | null };
  periods: BookingPeriod[];
};

/**
 * The location a public code names, when it takes online bookings: active, taking
 * reservations, and online booking turned on. Anything else is null, so an unknown code and a
 * closed one look the same (policy 12).
 */
export async function findPublicLocation(executor: DatabaseExecutor, code: string): Promise<PublicLocation | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
    return null;
  }

  const [row] = await executor
    .select({
      locationId: locations.id,
      organizationId: locations.organizationId,
      code: locations.locationCode,
      name: locations.name,
      phone: locations.phone,
      timeZone: locations.timezone,
      country: locations.country,
      settings: onlineBookingSettings,
    })
    .from(locations)
    .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
    .innerJoin(onlineBookingSettings, eq(onlineBookingSettings.locationId, locations.id))
    .where(
      and(
        sql`lower(${locations.locationCode}) = lower(${code})`,
        eq(locations.active, true),
        eq(locationSettings.allowReservations, true),
        eq(onlineBookingSettings.enabled, true),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  const { periods } = await readSettings(executor, row.locationId);

  return {
    locationId: row.locationId,
    organizationId: row.organizationId,
    code: row.code.toLowerCase(),
    name: row.name,
    phone: row.phone,
    timeZone: row.timeZone,
    country: row.country,
    settings: {
      minLeadMinutes: row.settings.minLeadMinutes,
      maxDaysAhead: row.settings.maxDaysAhead,
      slotIntervalMinutes: row.settings.slotIntervalMinutes,
      maxCoversPerSlot: row.settings.maxCoversPerSlot,
      maxPartySize: row.settings.maxPartySize,
      requiresApproval: row.settings.requiresApproval,
      publicNote: row.settings.publicNote,
    },
    periods,
  };
}

/** The allergens a guest may pick on the form: active ones, names only. */
export async function listPublicAllergens(executor: DatabaseExecutor, organizationId: string) {
  return executor
    .select({ code: allergens.code, name: allergens.name })
    .from(allergens)
    .where(and(eq(allergens.organizationId, organizationId), eq(allergens.active, true)))
    .orderBy(asc(allergens.displayOrder), asc(allergens.name));
}

/** Covers of active reservations per slot on a local date. */
async function bookedCoversOn(executor: DatabaseExecutor, location: PublicLocation, localDate: string) {
  const from = localToInstantLenient(localDate, "00:00", location.timeZone);
  const to = localToInstantLenient(addDays(localDate, 1), "00:00", location.timeZone);
  const rows = await executor
    .select({ reservationAt: reservations.reservationAt, partySize: guestParties.partySize })
    .from(reservations)
    .innerJoin(guestParties, eq(guestParties.id, reservations.guestPartyId))
    .where(
      and(
        eq(reservations.locationId, location.locationId),
        inArray(reservations.status, [...ACTIVE_STATUSES]),
        gte(reservations.reservationAt, from),
        lt(reservations.reservationAt, to),
      ),
    );
  const covers = new Map<string, number>();

  for (const row of rows) {
    const key = slotKey(localMinutesOf(row.reservationAt, location.timeZone), location.settings.slotIntervalMinutes);

    covers.set(key, (covers.get(key) ?? 0) + row.partySize);
  }

  return covers;
}

export async function offeredSlots(
  executor: DatabaseExecutor,
  location: PublicLocation,
  input: { localDate: string; partySize: number; now: Date },
) {
  return listOfferedSlots({
    localDate: input.localDate,
    today: localDateOf(input.now, location.timeZone),
    timeZone: location.timeZone,
    now: input.now,
    partySize: input.partySize,
    periods: location.periods,
    settings: location.settings,
    bookedCovers: await bookedCoversOn(executor, location, input.localDate),
  });
}

export type PublicRequestContext = { clientIp: string | null; now?: Date };

/** Counts an attempt per IP (behind a trusted proxy only) and per contact (policy 10). */
async function throttle(
  database: Database,
  context: PublicRequestContext,
  contacts: readonly string[],
  now: Date,
): Promise<void> {
  const config = getPublicBookingConfig();
  const checks: { key: string; limit: number }[] = [
    ...(config.clientIpHeader && context.clientIp
      ? [{ key: publicThrottleKey(config.throttleKey, "ip", context.clientIp), limit: config.ipThreshold }]
      : []),
    ...contacts.map((contact) => ({ key: publicThrottleKey(config.throttleKey, "contact", contact), limit: config.contactThreshold })),
  ];

  for (const check of checks) {
    if ((await countPublicAttempt(database, check.key, now, config.windowMs)) > check.limit) {
      throw new TooManyRequestsError();
    }
  }
}

/** Availability for the public page. Throttled per IP like a booking attempt. */
export async function getPublicAvailability(
  database: Database,
  code: string,
  input: { localDate: string; partySize: number },
  context: PublicRequestContext,
): Promise<{ times: string[] }> {
  const now = context.now ?? new Date();

  await throttle(database, context, [], now);

  const location = await findPublicLocation(database, code);

  if (!location) {
    throw new BusinessRuleError("ONLINE_BOOKING_CLOSED", CLOSED_MESSAGE);
  }

  return { times: (await offeredSlots(database, location, { ...input, now })).map((slot) => slot.localTime) };
}

export type OnlineBookingInput = {
  localDate: string;
  localTime: string;
  partySize: number;
  guestName: string;
  phone: string | null;
  email: string | null;
  specialRequests: string | null;
  messageConsent: ConsentChoice;
  allergies: readonly { code: string; severity: "SEVERE" | "ALLERGY" }[];
  /** The hidden spam-trap field: a person leaves it empty. */
  website: string;
  idempotencyKey: string;
};

export type OnlineBookingResult = {
  reference: string;
  status: "CONFIRMED" | "PENDING";
  localDate: string;
  localTime: string;
  when: string;
  partySize: number;
  locationName: string;
  /** The private view-or-cancel link. Shown once; only its hash is stored. */
  manageUrl: string;
};

export function bookingReference(reservationId: string): string {
  return `R-${reservationId.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

function requestKeyHash(locationId: string, idempotencyKey: string): string {
  return createHash("sha256").update(`${locationId}:${idempotencyKey}`).digest("hex");
}

/**
 * Books a table from the public page (policy 9). One transaction under the location's lock:
 * the slot and pacing are checked again, then the party, reservation, allergies, consents,
 * manage link, guest message, audit and outbox event are written together. A retry with the
 * same idempotency key returns the first booking with a fresh manage link and writes nothing
 * else. A filled spam trap gets a normal-looking answer and nothing is stored.
 */
export async function createOnlineReservation(
  database: Database,
  code: string,
  input: OnlineBookingInput,
  context: PublicRequestContext,
): Promise<OnlineBookingResult> {
  const now = context.now ?? new Date();
  const location = await findPublicLocation(database, code);

  if (!location) {
    await throttle(database, context, [], now);
    throw new BusinessRuleError("ONLINE_BOOKING_CLOSED", CLOSED_MESSAGE);
  }

  const phone = input.phone?.trim() || null;
  const email = input.email?.trim() || null;
  const sms = toE164(phone, location.country) ?? (phone ? phone.replace(/\D/g, "") : null);
  const normalizedEmail = email ? normalizeMessageAddress("EMAIL", email) : null;

  await throttle(database, context, [sms, normalizedEmail].filter((value): value is string => Boolean(value)), now);

  if (input.website.trim() !== "") {
    return {
      reference: bookingReference(randomUUID()),
      status: location.settings.requiresApproval ? "PENDING" : "CONFIRMED",
      localDate: input.localDate,
      localTime: input.localTime,
      when: input.localDate,
      partySize: input.partySize,
      locationName: location.name,
      manageUrl: manageUrl("x".repeat(43)),
    };
  }

  if (!phone && !email) {
    throw new BusinessRuleError("CONTACT_REQUIRED", "Give a phone number or an email address so we can reach you.");
  }

  if (email && !normalizedEmail) {
    throw new BusinessRuleError("EMAIL_NOT_USABLE", "Enter a valid email address.");
  }

  assertNoCardNumbers({ guestName: input.guestName, specialRequests: input.specialRequests });

  const keyHash = requestKeyHash(location.locationId, input.idempotencyKey);

  return withTransaction(database, async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`online-booking:${location.locationId}`}, 0))`);

    const [previous] = await transaction
      .select({ id: reservations.id, status: reservations.status, reservationAt: reservations.reservationAt, partySize: guestParties.partySize })
      .from(reservations)
      .innerJoin(guestParties, eq(guestParties.id, reservations.guestPartyId))
      .where(eq(reservations.onlineRequestKeyHash, keyHash));

    if (previous) {
      const token = await createManageLink(transaction, { reservationId: previous.id, reservationAt: previous.reservationAt, now });

      return resultFor(location, previous, token);
    }

    if (input.partySize > location.settings.maxPartySize) {
      throw new BusinessRuleError(
        "PARTY_TOO_LARGE",
        `For parties over ${location.settings.maxPartySize}, please call us${location.phone ? ` on ${location.phone}` : ""}.`,
      );
    }

    const today = localDateOf(now, location.timeZone);

    if (input.localDate < today || input.localDate > addDays(today, location.settings.maxDaysAhead)) {
      throw new BusinessRuleError("OUTSIDE_BOOKING_WINDOW", `Bookings open up to ${location.settings.maxDaysAhead} days ahead.`);
    }

    const slot = (await offeredSlots(transaction, location, { localDate: input.localDate, partySize: input.partySize, now })).find(
      (offered) => offered.localTime === input.localTime,
    );

    if (!slot) {
      throw new ConflictError("SLOT_UNAVAILABLE", "That time is no longer available. Please pick another.");
    }

    await assertContactLimit(transaction, location, { sms, email: normalizedEmail, now });

    const context = await readReservationContext(transaction, location.locationId);
    const status = location.settings.requiresApproval ? "PENDING" : "CONFIRMED";
    const [party] = await transaction
      .insert(guestParties)
      .values({
        locationId: location.locationId,
        partySize: input.partySize,
        guestName: input.guestName.trim(),
        phone,
        email,
        specialRequests: input.specialRequests?.trim() || null,
        status: "EXPECTED",
      })
      .returning({ id: guestParties.id });

    await appendPartyHistory(transaction, {
      partyId: party!.id,
      status: "EXPECTED",
      reason: "Booked online",
      userId: null,
      occurredAt: now,
    });

    const [reservation] = await transaction
      .insert(reservations)
      .values({
        guestPartyId: party!.id,
        locationId: location.locationId,
        reservationAt: slot.at,
        businessDate: businessDateOf(slot.at, context),
        expectedDurationMinutes: context.defaultReservationDurationMinutes,
        status,
        source: "ONLINE",
        createdByUserId: null,
        onlineRequestKeyHash: keyHash,
      })
      .returning({ id: reservations.id, version: reservations.version });

    await recordOnlineAllergies(transaction, location, party!.id, input.allergies, now);
    await reconcilePartyConsents(
      transaction,
      { kind: "GUEST", organizationId: location.organizationId, locationId: location.locationId },
      { guestPartyId: party!.id, locationId: location.locationId, contact: { phone, email }, choice: input.messageConsent, now },
    );

    const token = await createManageLink(transaction, { reservationId: reservation!.id, reservationAt: slot.at, now });

    await queueReservationMessage(transaction, {
      reservationId: reservation!.id,
      kind: status === "CONFIRMED" ? "RESERVATION_CONFIRMED" : "RESERVATION_RECEIVED",
      trigger: "online",
      now,
    });

    const guest = { guest: true as const, organizationId: location.organizationId, locationId: location.locationId };

    await recordAudit(transaction, guest, {
      action: "reservations.online-booked",
      entityId: reservation!.id,
      after: { status, partySize: input.partySize, allergyCount: input.allergies.length },
    });
    await writeOutboxEvents(transaction, [
      {
        organizationId: location.organizationId,
        locationId: location.locationId,
        eventType: "reservation.online-booked",
        aggregateType: "reservation",
        aggregateId: reservation!.id,
        payload: { reservationId: reservation!.id },
        occurredAt: now,
      },
    ]);

    return resultFor(location, { id: reservation!.id, status, reservationAt: slot.at, partySize: input.partySize }, token);
  });
}

function resultFor(
  location: PublicLocation,
  reservation: { id: string; status: string; reservationAt: Date; partySize: number },
  token: string,
): OnlineBookingResult {
  return {
    reference: bookingReference(reservation.id),
    status: reservation.status === "PENDING" ? "PENDING" : "CONFIRMED",
    localDate: localDateOf(reservation.reservationAt, location.timeZone),
    localTime: localTimeOf(reservation.reservationAt, location.timeZone),
    when: formatMessageTime(reservation.reservationAt, location.timeZone),
    partySize: reservation.partySize,
    locationName: location.name,
    manageUrl: manageUrl(token),
  };
}

/** At most two upcoming online bookings per phone or email at a location (D7). */
async function assertContactLimit(
  transaction: DatabaseTransaction,
  location: PublicLocation,
  input: { sms: string | null; email: string | null; now: Date },
): Promise<void> {
  const rows = await transaction
    .select({ phone: guestParties.phone, email: guestParties.email })
    .from(reservations)
    .innerJoin(guestParties, eq(guestParties.id, reservations.guestPartyId))
    .where(
      and(
        eq(reservations.locationId, location.locationId),
        eq(reservations.source, "ONLINE"),
        inArray(reservations.status, ["PENDING", "CONFIRMED"]),
        gt(reservations.reservationAt, input.now),
      ),
    );
  const matches = rows.filter(
    (row) =>
      (input.sms && (toE164(row.phone, location.country) ?? row.phone?.replace(/\D/g, "")) === input.sms) ||
      (input.email && row.email && normalizeMessageAddress("EMAIL", row.email) === input.email),
  );

  if (matches.length >= MAX_UPCOMING_ONLINE_PER_CONTACT) {
    throw new BusinessRuleError(
      "TOO_MANY_BOOKINGS",
      "You already have upcoming bookings with us. Please call us to book more.",
    );
  }
}

async function recordOnlineAllergies(
  transaction: DatabaseTransaction,
  location: PublicLocation,
  guestPartyId: string,
  allergies: OnlineBookingInput["allergies"],
  now: Date,
): Promise<void> {
  if (allergies.length === 0) {
    return;
  }

  const known = await transaction
    .select({ id: allergens.id, code: allergens.code })
    .from(allergens)
    .where(
      and(
        eq(allergens.organizationId, location.organizationId),
        eq(allergens.active, true),
        inArray(allergens.code, allergies.map((allergy) => allergy.code)),
      ),
    );
  const byCode = new Map(known.map((row) => [row.code, row.id]));
  const rows = [...new Map(allergies.map((allergy) => [allergy.code, allergy])).values()]
    .filter((allergy) => byCode.has(allergy.code))
    .map((allergy) => ({
      organizationId: location.organizationId,
      guestPartyId,
      allergenId: byCode.get(allergy.code)!,
      severity: allergy.severity,
      source: "ONLINE",
      recordedByUserId: null,
      recordedAt: now,
    }));

  if (rows.length !== new Set(allergies.map((allergy) => allergy.code)).size) {
    throw new BusinessRuleError("UNKNOWN_ALLERGEN", "Pick allergies from the list.");
  }

  await transaction.insert(guestPartyAllergies).values(rows);
}

// ---------------------------------------------------------------------------------------------
// The private manage link (D11, policy 11)
// ---------------------------------------------------------------------------------------------

export type ManagedReservationView = {
  reference: string;
  locationName: string;
  locationPhone: string | null;
  when: string;
  partySize: number;
  status: "PENDING" | "CONFIRMED" | "CANCELLED" | "OTHER";
  canCancel: boolean;
};

const INVALID_LINK = "This link isn't valid. It may have expired, or the booking may have changed.";

async function findByToken(executor: DatabaseExecutor, token: string, now: Date) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return null;
  }

  const [row] = await executor
    .select({
      reservation: reservations,
      partyId: guestParties.id,
      partyStatus: guestParties.status,
      partySize: guestParties.partySize,
      organizationId: locations.organizationId,
      locationName: locations.name,
      locationPhone: locations.phone,
      timeZone: locations.timezone,
      postGraceMinutes: locationSettings.reservationPostGraceMinutes,
      revokedAt: reservationManageLinks.revokedAt,
    })
    .from(reservationManageLinks)
    .innerJoin(reservations, eq(reservations.id, reservationManageLinks.reservationId))
    .innerJoin(guestParties, eq(guestParties.id, reservations.guestPartyId))
    .innerJoin(locations, eq(locations.id, reservations.locationId))
    .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
    .where(eq(reservationManageLinks.tokenHash, hashToken(token)));

  if (
    !row ||
    row.revokedAt ||
    ["COMPLETED", "NO_SHOW", "SEATED"].includes(row.reservation.status) ||
    now.getTime() >= row.reservation.reservationAt.getTime() + row.postGraceMinutes * 60_000
  ) {
    return null;
  }

  return row;
}

function canGuestCancel(row: NonNullable<Awaited<ReturnType<typeof findByToken>>>, now: Date): boolean {
  return (
    (row.reservation.status === "PENDING" || row.reservation.status === "CONFIRMED") &&
    row.partyStatus === "EXPECTED" &&
    now.getTime() < row.reservation.reservationAt.getTime()
  );
}

/** What the manage page shows, or null for any link that doesn't work (one answer for all). */
export async function getManagedReservation(
  database: Database,
  token: string,
  context: PublicRequestContext,
): Promise<ManagedReservationView | null> {
  const now = context.now ?? new Date();

  await throttle(database, context, [], now);

  const row = await findByToken(database, token, now);

  if (!row) {
    return null;
  }

  const status = row.reservation.status;

  return {
    reference: bookingReference(row.reservation.id),
    locationName: row.locationName,
    locationPhone: row.locationPhone,
    when: formatMessageTime(row.reservation.reservationAt, row.timeZone),
    partySize: row.partySize,
    status: status === "PENDING" || status === "CONFIRMED" || status === "CANCELLED" ? status : "OTHER",
    canCancel: canGuestCancel(row, now),
  };
}

/**
 * The guest cancels through the link (policy 11): the ordinary cancel transition with a GUEST
 * actor. Waiting messages are cancelled, the slot's covers free up, and the guest is told.
 */
export async function cancelReservationByGuest(
  database: Database,
  token: string,
  context: PublicRequestContext,
): Promise<{ cancelled: true }> {
  const now = context.now ?? new Date();

  await throttle(database, context, [], now);

  return withTransaction(database, async (transaction) => {
    const found = await findByToken(transaction, token, now);

    if (!found) {
      throw new BusinessRuleError("INVALID_LINK", INVALID_LINK);
    }

    const graph = await lockPartyGraph(transaction, found.reservation.locationId, found.partyId);
    const row = { ...found, reservation: graph.reservation!, partyStatus: graph.party.status };

    if (!canGuestCancel(row, now)) {
      throw new BusinessRuleError(
        "GUEST_CANNOT_CANCEL",
        `This booking can't be cancelled online now.${found.locationPhone ? ` Please call us on ${found.locationPhone}.` : ""}`,
      );
    }

    assertReservationTransition(graph.reservation!.status as ReservationStatus, "CANCELLED");
    await endAssignments(transaction, { reservationId: graph.reservation!.id, reason: "CANCELLED", userId: null, at: now });
    await changePartyStatus(transaction, {
      party: graph.party,
      status: "CANCELLED",
      reason: "Cancelled by guest",
      userId: null,
      occurredAt: now,
    });
    await transaction
      .update(reservations)
      .set({
        status: "CANCELLED",
        cancelledAt: now,
        cancelledByGuest: true,
        cancelReason: "Cancelled by guest",
        version: nextVersion(reservations.version),
      })
      .where(eq(reservations.id, graph.reservation!.id));
    await cancelQueuedMessages(transaction, { reservationId: graph.reservation!.id, now });
    await queueReservationMessage(transaction, {
      reservationId: graph.reservation!.id,
      kind: "RESERVATION_CANCELLED",
      trigger: "cancelled",
      now,
    });
    await recordAudit(
      transaction,
      { guest: true, organizationId: found.organizationId, locationId: found.reservation.locationId },
      { action: "reservations.guest-cancelled", entityId: graph.reservation!.id, after: { status: "CANCELLED" } },
    );
    await writeOutboxEvents(transaction, [
      {
        organizationId: found.organizationId,
        locationId: found.reservation.locationId,
        eventType: "reservation.guest-cancelled",
        aggregateType: "reservation",
        aggregateId: graph.reservation!.id,
        payload: { reservationId: graph.reservation!.id },
        occurredAt: now,
      },
    ]);

    return { cancelled: true };
  });
}
