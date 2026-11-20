import { z } from "zod";

import { IDEMPOTENCY_KEY_PATTERN } from "@/infrastructure/idempotency/idempotency-service";

// Phase 32 shape only. Business rules are in the manager log and pre-shift services, and
// PostgreSQL has the final word.

const date = z.iso.date();
const expectedVersion = z.int().positive();
// Phase 33 (policy 17): a category code; the service checks it is an active one.
const category = z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,29}$/);

export const logQuerySchema = z
  .object({
    date: date.optional(),
    from: date.optional(),
    to: date.optional(),
    category: category.optional(),
    q: z.string().trim().max(200).optional(),
  })
  .refine((query) => Boolean(query.date) !== Boolean(query.from && query.to), {
    message: "Give one date, or a from and to date.",
  });

export const addLogEntrySchema = z.object({
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
  dateChoice: z.enum(["CURRENT", "PREVIOUS"]).default("CURRENT"),
  category,
  body: z.string().trim().min(1).max(4000),
  correctsEntryId: z.uuid().nullable().default(null),
});

export const redactLogEntrySchema = z.object({ reason: z.string().trim().min(1).max(500) });

export const logEntryIdParamsSchema = z.object({ entryId: z.uuid() });

export const noteRangeSchema = z.object({ from: date, to: date });

const noteFields = {
  businessDate: date,
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2000),
  pinned: z.boolean().default(false),
  positionIds: z.array(z.uuid()).max(50).default([]),
};

export const createNoteSchema = z.object(noteFields);

export const updateNoteSchema = z.object({ ...noteFields, expectedVersion });

export const withdrawNoteSchema = z.object({ expectedVersion });

export const noteIdParamsSchema = z.object({ noteId: z.uuid() });

export const redactNoteSchema = z.object({ reason: z.string().trim().min(1).max(500) });

// Phase 33 (policies 17–18): manager log categories.
export const addLogCategorySchema = z.object({
  name: z.string().trim().min(1).max(40),
  code: z.string().trim().max(30).nullable().optional(),
  sortOrder: z.int().min(0).max(10000).nullable().optional(),
});

export const updateLogCategorySchema = z.object({
  name: z.string().trim().min(1).max(40),
  sortOrder: z.int().min(0).max(10000),
  active: z.boolean(),
  expectedVersion,
});

export const logCategoryIdParamsSchema = z.object({ categoryId: z.uuid() });
