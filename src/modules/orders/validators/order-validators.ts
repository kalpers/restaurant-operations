import { z } from "zod";

import { IDEMPOTENCY_KEY_PATTERN } from "@/infrastructure/idempotency/idempotency-service";

import { DISCOUNT_SCOPES, DISCOUNT_TYPES, ORDER_STATUSES, ORDER_TYPES, VOID_DISPOSITIONS } from "../types";

// Shape only. Business rules are in the services and workflows; PostgreSQL has the final word.

const expectedVersion = z.int().positive();
const reason = z.string().trim().min(1).max(300);
const decimal = z.string().trim().regex(/^\d+(\.\d+)?$/);

export const orderIdParamsSchema = z.object({ orderId: z.uuid() });
export const orderItemParamsSchema = z.object({ orderId: z.uuid(), itemId: z.uuid() });
export const orderDiscountParamsSchema = z.object({ orderId: z.uuid(), discountId: z.uuid() });
export const discountDefinitionParamsSchema = z.object({ definitionId: z.uuid() });

export const listOrdersQuerySchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  orderType: z.enum(ORDER_TYPES).optional(),
  tableSessionId: z.uuid().optional(),
});

export const createOrderSchema = z.discriminatedUnion("orderType", [
  z.object({ orderType: z.literal("DINE_IN"), tableSessionId: z.uuid() }),
  z.object({ orderType: z.literal("BAR"), tableSessionId: z.uuid() }),
  z.object({
    orderType: z.literal("TAKEOUT"),
    customerName: z.string().trim().max(60).nullable().optional(),
  }),
]);

const selections = z
  .array(z.object({ modifierGroupId: z.uuid(), modifierId: z.uuid() }))
  .max(50)
  .default([]);
const specialInstructions = z
  .string()
  .trim()
  .max(500)
  .nullable()
  .default(null)
  .transform((value) => (value === "" ? null : value));

export const addDraftItemSchema = z.object({
  expectedVersion,
  menuItemId: z.uuid(),
  quantity: z.int().min(1).max(99),
  selections,
  specialInstructions,
  courseNumber: z.int().min(1).max(5).optional(),
});

export const updateDraftItemSchema = z.object({
  expectedVersion,
  quantity: z.int().min(1).max(99),
  selections,
  specialInstructions,
  courseNumber: z.int().min(1).max(5).optional(),
});

export const expectedVersionSchema = z.object({ expectedVersion });

export const sendOrderSchema = z.object({
  expectedVersion,
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
  /** Phase 17: ALL (default) fires everything; FIRST_COURSE holds later courses. */
  fire: z.enum(["ALL", "FIRST_COURSE"]).default("ALL"),
});

export const fireCourseParamsSchema = z.object({ orderId: z.uuid(), course: z.coerce.number().int().min(1).max(5) });

export const fireCourseSchema = z.object({
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN).optional(),
});

export const voidItemSchema = z.object({
  expectedVersion,
  reason,
  disposition: z.enum(VOID_DISPOSITIONS),
});

export const voidOrderSchema = z.object({
  expectedVersion,
  reason,
  dispositions: z.record(z.uuid(), z.enum(VOID_DISPOSITIONS)).default({}),
});

export const applyDiscountSchema = z.object({
  expectedVersion,
  discountDefinitionId: z.uuid(),
  reason,
});

export const removeDiscountSchema = z.object({ expectedVersion, reason });

export const createDiscountDefinitionSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_]{0,39}$/, "Use letters, digits and underscores."),
  name: z.string().trim().min(1).max(80),
  scope: z.enum(DISCOUNT_SCOPES),
  discountType: z.enum(DISCOUNT_TYPES),
  value: decimal,
});

export const updateDiscountDefinitionSchema = z.object({
  expectedVersion,
  name: z.string().trim().min(1).max(80),
  value: decimal,
  active: z.boolean(),
});

/** Phase 17 split checks: move items to another check on the session, or a new one. */
export const moveItemsSchema = z.object({
  itemIds: z.array(z.uuid()).min(1).max(100),
  expectedVersion,
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
  target: z.union([
    z.object({ orderId: z.uuid(), expectedVersion }),
    z.object({ newCheck: z.literal(true) }),
  ]),
});

/** Phase 20 (policy 16): shape only; the service checks the reason and the digit rule. */
export const setTaxExemptionSchema = z.object({
  reason: z.string().trim().min(1).max(200),
  reference: z.string().trim().max(60).nullish(),
  expectedVersion,
});

export const clearTaxExemptionSchema = z.object({ expectedVersion });

/** Phase 20 (policy 17): one target per share; the workflow checks counts and checks. */
export const splitItemSchema = z.object({
  shareCount: z.int().min(2).max(10),
  targets: z
    .array(z.union([z.object({ orderId: z.uuid(), expectedVersion }), z.object({ newCheck: z.literal(true) })]))
    .min(2)
    .max(10),
  expectedVersion,
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
});

export const orderShareParamsSchema = z.object({ orderId: z.uuid(), shareId: z.uuid() });

export const voidShareSchema = z.object({
  reason: z.string().trim().min(1).max(300),
  expectedVersion,
  shareVersion: expectedVersion,
});
