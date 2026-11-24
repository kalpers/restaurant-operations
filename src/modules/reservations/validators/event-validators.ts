import { z } from "zod";

import { EVENT_DEPOSIT_METHODS, EVENT_SPACE_SCOPES, EVENT_STATUSES } from "@/db/schema/events";

// Phase 36 part 3 shape only. Business rules are in the event service, and PostgreSQL has the
// final word.

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const money = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/)
  .nullable()
  .optional();
const optionalText = (max: number) => z.string().max(max).nullable().optional();

const eventFields = {
  name: z.string().trim().min(1).max(120),
  guestName: z.string().trim().min(1).max(200),
  partySize: z.int().min(1).max(1000),
  phone: optionalText(40),
  email: optionalText(254),
  localDate: z.iso.date(),
  startTime: time,
  endTime: time,
  setupMinutes: z.int().min(0).max(480).default(0),
  teardownMinutes: z.int().min(0).max(480).default(0),
  spaceScope: z.enum(EVENT_SPACE_SCOPES),
  restaurantAreaId: z.uuid().nullable().optional(),
  tableIds: z.array(z.uuid()).max(100).default([]),
  notes: optionalText(4000),
  menuNotes: optionalText(2000),
  menuItemId: z.uuid().nullable().optional(),
  minimumSpend: money,
  depositAgreed: money,
  depositReceived: money,
  depositReceivedOn: z.iso.date().nullable().optional(),
  depositMethod: z.enum(EVENT_DEPOSIT_METHODS).nullable().optional(),
  depositReference: optionalText(80),
};

export const createEventSchema = z.object({
  ...eventFields,
  guestProfileId: z.uuid().nullable().optional(),
  status: z.enum(["INQUIRY", "TENTATIVE", "CONFIRMED"]).default("INQUIRY"),
});

export const updateEventSchema = z.object({ ...eventFields, expectedVersion: z.int().positive() });

export const changeEventStatusSchema = z.object({
  status: z.enum(["INQUIRY", "TENTATIVE", "CONFIRMED", "CANCELLED"]),
  reason: z.string().max(500).nullable().optional(),
  expectedVersion: z.int().positive(),
});

export const seatEventSchema = z.object({
  expectedVersion: z.int().positive(),
  tableIds: z.array(z.uuid()).max(100).nullable().optional(),
  serverEmployeeId: z.uuid().nullable().optional(),
  capacityOverrideReason: z.string().trim().max(500).nullable().optional(),
  scheduleOverrideReason: z.string().trim().max(500).nullable().optional(),
  holdOverrideReason: z.string().trim().max(500).nullable().optional(),
});

export const eventIdParamsSchema = z.object({ eventId: z.uuid() });

export const eventListQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  status: z.enum(EVENT_STATUSES).optional(),
});
