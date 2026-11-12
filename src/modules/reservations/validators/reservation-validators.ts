import { z } from "zod";

import {
  CREATABLE_RESERVATION_STATUSES,
  RESERVATION_SOURCES,
  RESERVATION_STATUSES,
} from "../types";

// Shape only. Business rules are in the services and PostgreSQL has the final word.

const expectedVersion = z.int().positive();
const partySize = z.int().min(1).max(500);
const minutes = z.int().min(1).max(24 * 60);
const requiredText = (max: number) => z.string().trim().min(1).max(max);

/** Blank becomes null, so "no value" has one representation. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((value) => (value === "" ? null : value));

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const tableIds = z.array(z.uuid()).max(3);
const seatTableIds = z.array(z.uuid()).min(1).max(30);
/** Phase 22 (policy 5): the guest agreed to texts or emails about this visit. */
const messageConsent = z.object({ sms: z.boolean(), email: z.boolean() }).strict();

const guestFields = {
  guestName: requiredText(120),
  partySize,
  phone: optionalText(40),
  email: optionalText(200),
  specialRequests: optionalText(500),
};

export const reservationIdParamsSchema = z.object({ reservationId: z.uuid() });
export const entryIdParamsSchema = z.object({ entryId: z.uuid() });
export const expectedVersionSchema = z.object({ expectedVersion });

export const createReservationSchema = z.object({
  ...guestFields,
  localDate,
  localTime,
  expectedDurationMinutes: minutes.nullable().default(null),
  source: z.enum(RESERVATION_SOURCES),
  notes: optionalText(500),
  status: z.enum(CREATABLE_RESERVATION_STATUSES).default("CONFIRMED"),
  tableIds: tableIds.default([]),
  /** Phase 21: link the new visit to a guest profile. */
  guestProfileId: z.uuid().nullable().default(null),
  messageConsent: messageConsent.optional(),
});

export const updateReservationSchema = z.object({
  ...guestFields,
  localDate,
  localTime,
  expectedDurationMinutes: minutes,
  notes: optionalText(500),
  /** Left out, the planned tables stay as they are. */
  tableIds: tableIds.optional(),
  /** Left out, consent stays as it is (a changed address still withdraws its channel). */
  messageConsent: messageConsent.optional(),
  expectedVersion,
});

export const cancelReservationSchema = z.object({
  reason: optionalText(500),
  expectedVersion,
});

export const plannedTablesSchema = z.object({
  tableIds,
  expectedVersion,
});

export const conflictPreviewSchema = z.object({
  tableIds: z.array(z.uuid()).max(3),
  localDate,
  localTime,
  expectedDurationMinutes: minutes,
  partySize,
  excludeReservationId: z.uuid().nullable().default(null),
});

export const listReservationsQuerySchema = z.object({
  from: localDate.optional(),
  to: localDate.optional(),
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : []))
    .pipe(z.array(z.enum(RESERVATION_STATUSES))),
});

const seatOptions = {
  tableIds: seatTableIds,
  serverEmployeeId: z.uuid().nullable().optional(),
  capacityOverrideReason: optionalText(500),
  scheduleOverrideReason: optionalText(500),
  holdOverrideReason: optionalText(500),
  notes: optionalText(500),
};

export const seatReservationSchema = z.object({
  ...seatOptions,
  expectedVersion,
});

export const seatWaitlistSchema = z.object({
  ...seatOptions,
  expectedVersion,
});

export const seatWalkInSchema = z.object({
  ...guestFields,
  ...seatOptions,
  /** Phase 21: link the walk-in to a guest profile. */
  guestProfileId: z.uuid().nullable().default(null),
});

export const addToWaitlistSchema = z
  .object({
    guestName: requiredText(120).optional(),
    partySize: partySize.optional(),
    phone: optionalText(40),
    email: optionalText(200),
    specialRequests: optionalText(500),
    /** A reservation party joining the waitlist, so no second party is made. */
    guestPartyId: z.uuid().optional(),
    quotedWaitMinutes: z.int().min(0).max(24 * 60).nullable().default(null),
    preferredAreaId: z.uuid().nullable().default(null),
    notes: optionalText(500),
    /** Phase 21: link the new walk-in to a guest profile. */
    guestProfileId: z.uuid().nullable().default(null),
    messageConsent: messageConsent.optional(),
  })
  .refine(
    (value) => value.guestPartyId || (value.guestName && value.partySize),
    { message: "A name and party size, or an existing party, are required." },
  );

export const updateWaitlistSchema = z.object({
  quotedWaitMinutes: z.int().min(0).max(24 * 60).nullable(),
  preferredAreaId: z.uuid().nullable().optional(),
  notes: optionalText(500).optional(),
  expectedVersion,
});

export const waitlistTablesSchema = z.object({
  tableIds,
  expectedVersion,
});

export const removeWaitlistSchema = z.object({
  outcome: z.enum(["CANCELLED", "LEFT"]),
  reason: optionalText(500),
  expectedVersion,
});

export const recommendationQuerySchema = z.object({
  partySize: z.coerce.number().int().min(1).max(500),
  areaId: z.uuid().optional(),
  guestPartyId: z.uuid().optional(),
});

export const quoteQuerySchema = z.object({
  partySize: z.coerce.number().int().min(1).max(500),
});

// Phase 21 guest profiles (policies 1-8). Shape only; the services apply the rules.
const severity = z.enum(["SEVERE", "ALLERGY"]);
const allergy = z.object({ allergenId: z.uuid(), severity, note: optionalText(200) });

export const guestProfileIdParamsSchema = z.object({ profileId: z.uuid() });
export const guestPartyIdParamsSchema = z.object({ partyId: z.uuid() });

const profileFields = {
  displayName: requiredText(120),
  phone: optionalText(40),
  email: optionalText(254),
  vip: z.boolean().default(false),
  vipReason: optionalText(200),
  preferences: optionalText(500),
  notes: optionalText(1000),
  otherDietaryNeeds: optionalText(500),
};

export const createGuestProfileSchema = z.object({
  ...profileFields,
  allergies: z.array(allergy).max(30).default([]),
});

export const updateGuestProfileSchema = z.object({ ...profileFields, expectedVersion });

export const setGuestAllergiesSchema = z.object({ allergies: z.array(allergy).max(30), expectedVersion });

export const guestSearchSchema = z.object({ q: z.string().trim().max(120).default("") });

export const linkPartySchema = z.object({ guestProfileId: z.uuid(), expectedPartyVersion: expectedVersion });
export const unlinkPartySchema = z.object({ expectedPartyVersion: expectedVersion });

export const partyAllergySchema = z.object({
  expectedPartyVersion: expectedVersion,
  allergenId: z.uuid(),
  severity,
  note: optionalText(200),
  saveToProfile: z.boolean().default(false),
});

export const removePartyAllergySchema = z.object({ expectedPartyVersion: expectedVersion, allergenId: z.uuid() });

export const mergeGuestProfilesSchema = z.object({
  keptProfileId: z.uuid(),
  duplicateVersion: expectedVersion,
  keptVersion: expectedVersion,
  reason: requiredText(200),
});

export const eraseGuestProfileSchema = z.object({ expectedVersion, reason: requiredText(200) });
/** Phase 22 (policy 17): the party's version and why. */
export const eraseGuestVisitSchema = z.object({ expectedVersion, reason: requiredText(200) });

export const messageChannelParamsSchema = z.object({ partyId: z.uuid(), channel: z.enum(["SMS", "EMAIL"]) });
export const messageIdParamsSchema = z.object({ messageId: z.uuid() });

// Phase 22 online booking (policies 7-11). Shape only; the service checks the rules.
const bookingTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const bookingPeriod = z.object({ weekday: z.int().min(0).max(6), startsAt: bookingTime, endsAt: bookingTime }).strict();

export const onlineBookingSettingsSchema = z
  .object({
    enabled: z.boolean(),
    requiresApproval: z.boolean(),
    maxPartySize: z.int().min(1).max(50),
    minLeadMinutes: z.int().min(0).max(10080),
    maxDaysAhead: z.int().min(1).max(365),
    slotIntervalMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
    maxCoversPerSlot: z.int().min(1).max(1000),
    reminderHoursBefore: z.int().min(0).max(168),
    publicNote: optionalText(500),
    expectedVersion: z.int().positive().nullable(),
  })
  .strict();

export const bookingPeriodsSchema = z.object({ periods: z.array(bookingPeriod).max(42) }).strict();

export const publicLocationParamsSchema = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
export const publicTokenParamsSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export const publicAvailabilityQuerySchema = z.object({
  date: localDate,
  partySize: z.coerce.number().int().min(1).max(50),
});

export const onlineBookingSchema = z
  .object({
    localDate,
    localTime: bookingTime,
    partySize: z.int().min(1).max(50),
    guestName: requiredText(120),
    phone: optionalText(40),
    email: optionalText(200),
    specialRequests: optionalText(500),
    messageConsent,
    allergies: z
      .array(z.object({ code: z.string().regex(/^[A-Z0-9_]{1,40}$/), severity: z.enum(["SEVERE", "ALLERGY"]) }).strict())
      .max(20)
      .default([]),
    /** The spam trap: hidden from people, filled by naive bots. */
    website: z.string().max(200).default(""),
    idempotencyKey: z.uuid(),
  })
  .strict();
