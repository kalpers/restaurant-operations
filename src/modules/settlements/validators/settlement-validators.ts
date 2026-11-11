import { z } from "zod";

import { IDEMPOTENCY_KEY_PATTERN } from "@/infrastructure/idempotency/idempotency-service";

import { looksLikeCardNumber } from "../rules/settlement-math";
import { TENDER_TYPES } from "../types";

// Shape only. Business rules are in the services and the close-order workflow; PostgreSQL
// has the final word. No field accepts a card number, CVV, PIN or track data.

const expectedVersion = z.int().positive();
const idempotencyKey = z.string().regex(IDEMPOTENCY_KEY_PATTERN);
const money = z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, "Enter an amount in dollars and cents.");
const noCardNumber = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !looksLikeCardNumber(value), "Don't enter card numbers.")
    .nullable()
    .optional()
    .transform((value) => (value ? value : null));
const reason = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !looksLikeCardNumber(value), "Don't enter card numbers.");

export const settlementIdParamsSchema = z.object({ settlementId: z.uuid() });
export const tenderParamsSchema = z.object({ settlementId: z.uuid(), tenderId: z.uuid() });

export const recordTenderSchema = z.object({
  expectedVersion,
  idempotencyKey,
  tenderType: z.enum(TENDER_TYPES),
  outcome: z.enum(["RECORDED", "FAILED"]).default("RECORDED"),
  amount: money,
  tipAmount: money.nullable().optional().transform((value) => value ?? null),
  receivedAmount: money.nullable().optional().transform((value) => value ?? null),
  externalReference: noCardNumber(80),
  providerName: noCardNumber(60),
  cardBrand: noCardNumber(30),
  cardLastFour: z
    .string()
    .trim()
    .regex(/^\d{4}$/, "Enter exactly the last four digits.")
    .nullable()
    .optional()
    .or(z.literal(""))
    .transform((value) => (value ? value : null)),
  authorizationReference: noCardNumber(40),
  otherDescription: noCardNumber(200),
  failureReason: noCardNumber(200),
  /** Phase 17: the open drawer session for cash. */
  cashDrawerSessionId: z.uuid().nullable().optional(),
});

export const voidTenderSchema = z.object({ expectedVersion, reason });

export const cancelSettlementSchema = z.object({ expectedVersion, reason });

export const completeSettlementSchema = z.object({ expectedVersion, idempotencyKey });

// ---------------------------------------------------------------- Phase 17

const drawerCode = z
  .string()
  .trim()
  .regex(/^[A-Z0-9][A-Z0-9_]{0,19}$/, "Use capital letters, digits and underscores.");
const shortText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !looksLikeCardNumber(value), "Don't enter card numbers.");

export const drawerIdParamsSchema = z.object({ drawerId: z.uuid() });
export const drawerSessionParamsSchema = z.object({ sessionId: z.uuid() });
export const orderIdParamsSchema = z.object({ orderId: z.uuid() });
export const refundIdParamsSchema = z.object({ refundId: z.uuid() });

export const createDrawerSchema = z.object({ code: drawerCode, name: shortText(80) });
export const updateDrawerSchema = z.object({ name: shortText(80), active: z.boolean(), expectedVersion });
export const drawerSettingSchema = z.object({ required: z.boolean(), expectedVersion });
export const openDrawerSessionSchema = z.object({ openingFloat: money, idempotencyKey });
export const drawerMovementSchema = z.object({
  movementType: z.enum(["PAID_IN", "PAID_OUT"]),
  amount: money,
  reason: shortText(200),
  idempotencyKey,
});
export const closeDrawerSessionSchema = z.object({
  countedAmount: money,
  closeNote: noCardNumber(500),
  expectedVersion,
  idempotencyKey,
});

export const recordRefundSchema = z.object({
  idempotencyKey,
  tenderType: z.enum(TENDER_TYPES),
  amount: money,
  taxAmount: money.default("0.00"),
  reason,
  otherDescription: noCardNumber(200),
  externalReference: noCardNumber(80),
  cashDrawerSessionId: z.uuid().nullable().optional(),
  orderItemIds: z.array(z.uuid()).max(100).default([]),
});

export const voidRefundSchema = z.object({ expectedVersion, reason });
