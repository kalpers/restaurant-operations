import { z } from "zod";

import { IDEMPOTENCY_KEY_PATTERN } from "@/infrastructure/idempotency/idempotency-service";

import { ADJUSTMENT_REASONS, INVENTORY_TRANSACTION_TYPES, WASTE_REASONS } from "../types";

// Shape only. Business rules are in the services and PostgreSQL has the final word.

const expectedVersion = z.int().positive();
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

const code = z
  .string()
  .trim()
  .regex(/^[A-Z0-9][A-Z0-9_]{0,39}$/, "Use capital letters, digits and underscores.");
/** A decimal string, never coerced to a number. The services check scale and sign. */
const decimal = z.string().trim().regex(/^-?\d+(\.\d+)?$/);
const optionalDecimal = decimal.nullable().default(null);
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const itemIdParamsSchema = z.object({ itemId: z.uuid() });
export const conversionParamsSchema = z.object({ itemId: z.uuid(), conversionId: z.uuid() });
export const supplierIdParamsSchema = z.object({ supplierId: z.uuid() });
export const supplierItemIdParamsSchema = z.object({ supplierItemId: z.uuid() });
export const orderIdParamsSchema = z.object({ orderId: z.uuid() });
export const orderLineParamsSchema = z.object({ orderId: z.uuid(), lineId: z.uuid() });
export const countIdParamsSchema = z.object({ countId: z.uuid() });
export const countLineParamsSchema = z.object({ countId: z.uuid(), lineId: z.uuid() });

const itemFields = {
  name: requiredText(120),
  description: optionalText(500),
  measurementType: z.enum(["COUNT", "WEIGHT", "VOLUME"]),
  baseUnitId: z.uuid(),
};

export const createItemSchema = z.object({ code, ...itemFields });
export const updateItemSchema = z.object({ ...itemFields, active: z.boolean(), expectedVersion });

export const setItemLocationSchema = z.object({
  parLevel: optionalDecimal,
  reorderLevel: optionalDecimal,
  reorderTarget: optionalDecimal,
  storageNote: optionalText(200),
  active: z.boolean().default(true),
  /** Phase 19: the supplier item suggested orders use. Left out means unchanged. */
  preferredSupplierItemId: z.uuid().nullable().optional(),
  /** Null when stocking the item here for the first time. */
  expectedVersion: expectedVersion.nullable().default(null),
});

export const addConversionSchema = z.object({
  fromUnitId: z.uuid(),
  toUnitId: z.uuid(),
  factor: decimal,
});

export const versionSchema = z.object({ expectedVersion });

const movement = {
  inventoryItemId: z.uuid(),
  // Phase 23: lots (optional; only for lot-tracked items).
  lotId: z.uuid().nullable().optional(),
  expiresOn: businessDate.nullable().optional(),
  quantity: decimal,
  unitOfMeasureId: z.uuid(),
  notes: optionalText(500),
  occurredAt: instant.optional(),
};

export const wasteSchema = z.object({ ...movement, reasonCode: z.enum(WASTE_REASONS) });

export const adjustmentSchema = z.object({
  ...movement,
  direction: z.enum(["INCREASE", "DECREASE"]),
  reasonCode: z.enum(ADJUSTMENT_REASONS),
});

export const transferSchema = z.object({ ...movement, toLocationId: z.uuid() });

export const transactionFilterSchema = z.object({
  inventoryItemId: z.uuid().optional(),
  transactionType: z.enum(INVENTORY_TRANSACTION_TYPES).optional(),
  fromBusinessDate: businessDate.optional(),
  toBusinessDate: businessDate.optional(),
  referenceId: z.uuid().optional(),
});

const supplierFields = {
  name: requiredText(120),
  contactName: optionalText(120),
  phone: optionalText(40),
  email: optionalText(200),
};

export const createSupplierSchema = z.object({ code, ...supplierFields });
export const updateSupplierSchema = z.object({ ...supplierFields, active: z.boolean(), expectedVersion });

export const createSupplierItemSchema = z.object({
  inventoryItemId: z.uuid(),
  purchaseUnitId: z.uuid(),
  supplierSku: optionalText(60),
  lastUnitCost: optionalDecimal,
});

export const updateSupplierItemSchema = z.object({
  supplierSku: optionalText(60),
  lastUnitCost: optionalDecimal,
  active: z.boolean(),
  expectedVersion,
});

export const createOrderSchema = z.object({
  supplierId: z.uuid(),
  expectedAt: instant.nullable().default(null),
  notes: optionalText(1000),
});

export const updateOrderSchema = z.object({
  expectedAt: instant.nullable().default(null),
  notes: optionalText(1000),
  expectedVersion,
});

export const addOrderLineSchema = z.object({
  supplierItemId: z.uuid(),
  orderedQuantity: decimal,
  unitPrice: optionalDecimal,
  expectedVersion,
});

export const updateOrderLineSchema = z.object({
  orderedQuantity: decimal,
  unitPrice: decimal,
  expectedVersion,
});

export const cancelOrderSchema = z.object({ reason: optionalText(500), expectedVersion });

export const receiveSchema = z.object({
  lines: z
    .array(
      z.object({
        purchaseOrderLineId: z.uuid(),
        receivedQuantity: decimal,
        actualUnitCost: optionalDecimal,
        supplierLotCode: optionalText(64),
        expiresOn: businessDate.nullable().default(null),
      }),
    )
    .min(1)
    .max(200),
  supplierReference: optionalText(100),
  notes: optionalText(1000),
});

export const startCountSchema = z.object({
  name: requiredText(120),
  inventoryItemIds: z.array(z.uuid()).max(1000).nullable().default(null),
});

export const recordCountLineSchema = z.object({
  countedQuantity: optionalDecimal,
  notes: optionalText(500),
  expectedVersion,
});

export const approveCountSchema = z.object({
  expectedVersion,
  acknowledgeActivity: z.boolean().default(false),
});

// Phase 19: draft purchase orders from the low-stock shortfall.
export const createSuggestedOrdersSchema = z.object({
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
});

/** Phase 23 (policies 10–15): transfer records. */
const transferLine = z.object({
  inventoryItemId: z.uuid(),
  lotId: z.uuid().nullable().optional(),
  quantity: decimal,
  unitOfMeasureId: z.uuid(),
});

export const transferDraftSchema = z.object({
  toLocationId: z.uuid(),
  notes: optionalText(500),
  lines: z.array(transferLine).min(1).max(50),
});

export const transferDraftUpdateSchema = transferDraftSchema.extend({ expectedVersion });

export const transferSendSchema = z.object({
  expectedVersion,
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
});

export const transferReceiveSchema = transferSendSchema.extend({
  lines: z
    .array(z.object({ lineId: z.uuid(), quantityReceived: decimal }))
    .max(50)
    .nullable()
    .default(null),
});

export const transferIdParamsSchema = z.object({ transferId: z.uuid() });

/** Phase 23 (policies 20–22): lots. */
export const lotIdParamsSchema = z.object({ lotId: z.uuid() });

export const correctLotSchema = z.object({
  supplierLotCode: optionalText(64),
  expiresOn: businessDate.nullable(),
  reason: requiredText(200),
  expectedVersion,
});

export const wasteLotSchema = z.object({
  reasonCode: z.enum(["EXPIRED", "SPOILAGE", "OTHER"]).default("EXPIRED"),
  notes: optionalText(500),
});

export const lotTrackingSchema = z.object({ enabled: z.boolean(), expectedVersion });
