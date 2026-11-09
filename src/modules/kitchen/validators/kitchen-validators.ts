import { z } from "zod";

import { IDEMPOTENCY_KEY_PATTERN } from "@/infrastructure/idempotency/idempotency-service";

import { FULFILLMENT_ACTIONS, KITCHEN_ITEM_STATUSES, WORK_STATION_TYPES } from "../types";

// Shape only. Lifecycle, scope and stock rules live in the services and workflows.

export const queueQuerySchema = z.object({
  stationType: z.enum(WORK_STATION_TYPES),
  stationId: z.uuid().optional(),
  status: z.enum(KITCHEN_ITEM_STATUSES).optional(),
  orderType: z.enum(["DINE_IN", "BAR", "TAKEOUT"]).optional(),
});

export const ticketItemActionParamsSchema = z.object({
  ticketItemId: z.uuid(),
  action: z.enum(FULFILLMENT_ACTIONS),
});

export const transitionSchema = z.object({ expectedVersion: z.int().positive() });

export const remakeSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
});

export const markReadSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ ids: z.array(z.uuid()).min(1).max(100) }),
]);
