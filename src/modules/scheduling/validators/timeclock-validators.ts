import { z } from "zod";

import { IDEMPOTENCY_KEY_PATTERN } from "@/infrastructure/idempotency/idempotency-service";

// Phase 18 time clock request shapes. Business rules live in the service.

const idempotencyKey = z.string().regex(IDEMPOTENCY_KEY_PATTERN);
const expectedVersion = z.int().positive();
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const reason = z.string().trim().min(1).max(500);
const date = z.iso.date();

export const clockInSchema = z.object({
  employeeId: z.uuid().nullable().default(null),
  positionId: z.uuid().nullable().default(null),
  idempotencyKey,
});

export const clockOutSchema = z.object({
  entryId: z.uuid().nullable().default(null),
  expectedVersion: expectedVersion.nullable().default(null),
  idempotencyKey,
});

export const breakSchema = z.object({
  action: z.enum(["START", "END"]),
  paid: z.boolean().default(false),
  idempotencyKey,
});

const breakChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ADD"), startedAt: instant, endedAt: instant, paid: z.boolean() }),
  z.object({ kind: z.literal("UPDATE"), id: z.uuid(), startedAt: instant, endedAt: instant, paid: z.boolean() }),
  z.object({ kind: z.literal("REMOVE"), id: z.uuid() }),
]);

/** A blank form field arrives as null and means "leave it as it is". */
const unchanged = <T,>(schema: z.ZodType<T>) => schema.nullish().transform((value) => value ?? undefined);

export const adjustEntrySchema = z.object({
  expectedVersion,
  reason,
  clockInAt: unchanged(instant),
  clockOutAt: unchanged(instant),
  positionId: unchanged(z.uuid()),
  breaks: z.array(breakChange).max(20).optional(),
});

export const voidEntrySchema = z.object({ expectedVersion, reason });

export const entryIdParamsSchema = z.object({ entryId: z.uuid() });

export const boardQuerySchema = z.object({ date: date.optional() });
