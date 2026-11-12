import { z } from "zod";

import { IDEMPOTENCY_KEY_PATTERN } from "@/infrastructure/idempotency/idempotency-service";

// Phase 18 tip pool request shapes. Business rules live in the service and workflow.

const date = z.iso.date();

export const tipRuleSchema = z.object({
  name: z.string().trim().max(80).nullable().default(null),
  active: z.boolean(),
  positions: z
    .array(z.object({ positionId: z.uuid(), points: z.string().trim().min(1).max(10) }))
    .max(50),
  expectedVersion: z.int().positive().nullable(),
});

export const tipDateQuerySchema = z.object({ date });

export const tipRangeQuerySchema = z.object({ from: date, to: date });

export const finalizeTipsSchema = z.object({
  businessDate: date,
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
});

export const voidTipDistributionSchema = z.object({
  expectedVersion: z.int().positive(),
  reason: z.string().trim().min(1).max(500),
});

export const distributionIdParamsSchema = z.object({ distributionId: z.uuid() });

/** Phase 20 (policy 20): shape only; the service checks who may declare and when. */
export const declareTipsSchema = z.object({
  employeeId: z.uuid().optional(),
  businessDate: z.iso.date(),
  amount: z.string().trim().min(1).max(16),
  note: z.string().trim().max(300).nullish(),
  expectedVersion: z.int().positive().nullish(),
});
