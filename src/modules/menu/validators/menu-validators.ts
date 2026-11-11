import { z } from "zod";

import { SELECTION_TYPES } from "../rules/modifier-selection";
import { MENU_ITEM_TYPES, PREPARATION_EFFECT_TYPES, STATION_TYPES } from "../types";

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

/** A stable code. Not editable after creation, because other records refer to it. */
const code = z
  .string()
  .trim()
  .regex(/^[A-Z0-9][A-Z0-9_]{0,39}$/, "Use capital letters, digits and underscores.");
const displayOrder = z.int().min(0).max(100000).default(0);
/** A decimal string, never coerced to a number. The services check its scale. */
const decimalString = z.string().trim().regex(/^-?\d+(\.\d+)?$/);
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const categoryIdParamsSchema = z.object({ categoryId: z.uuid() });
export const menuIdParamsSchema = z.object({ menuId: z.uuid() });
export const itemIdParamsSchema = z.object({ itemId: z.uuid() });
export const placementIdParamsSchema = z.object({ placementId: z.uuid() });
export const groupIdParamsSchema = z.object({ groupId: z.uuid() });
export const modifierIdParamsSchema = z.object({ modifierId: z.uuid() });
export const stationIdParamsSchema = z.object({ stationId: z.uuid() });
export const attachmentIdParamsSchema = z.object({ attachmentId: z.uuid() });
export const windowIdParamsSchema = z.object({ windowId: z.uuid() });

export const createCategorySchema = z.object({
  code,
  name: requiredText(100),
  description: optionalText(500),
  displayOrder,
});

export const updateCategorySchema = createCategorySchema.omit({ code: true }).extend({
  active: z.boolean(),
  expectedVersion,
});

export const createMenuSchema = createCategorySchema;
export const updateMenuSchema = updateCategorySchema;

export const setMenuLocationSchema = z.object({
  locationId: z.uuid(),
  active: z.boolean().default(true),
});

export const addAvailabilityWindowSchema = z.object({
  locationId: z.uuid(),
  effectiveFrom: instant,
  effectiveTo: instant.nullable().default(null),
});

export const createItemSchema = z.object({
  code,
  name: requiredText(120),
  shortName: optionalText(40),
  description: optionalText(500),
  itemType: z.enum(MENU_ITEM_TYPES),
  displayOrder,
  /** Phase 17: omitted leaves it unchanged; null clears it. */
  taxCategoryId: z.uuid().nullable().optional(),
});

export const updateItemSchema = createItemSchema.omit({ code: true }).extend({
  active: z.boolean(),
  available: z.boolean(),
  expectedVersion,
});

export const createPlacementSchema = z.object({
  menuId: z.uuid(),
  menuCategoryId: z.uuid(),
  menuItemId: z.uuid(),
  displayOrder,
});

export const updatePlacementSchema = z.object({
  displayOrder,
  active: z.boolean(),
  expectedVersion,
});

export const changePriceSchema = z.object({
  /** Null is the organization default; a location ID is a location-specific price. */
  locationId: z.uuid().nullable().default(null),
  price: decimalString,
  /** Null means "now". A given start can't be in the past. */
  effectiveFrom: instant.nullable().default(null),
});

export const createGroupSchema = z.object({
  code,
  name: requiredText(100),
  description: optionalText(500),
  selectionType: z.enum(SELECTION_TYPES),
  minimumSelections: z.int().min(0).max(100),
  maximumSelections: z.int().min(1).max(100).nullable().default(null),
  displayOrder,
});

export const updateGroupSchema = createGroupSchema.omit({ code: true }).extend({
  active: z.boolean(),
  expectedVersion,
});

export const createModifierSchema = z.object({
  code,
  name: requiredText(100),
  description: optionalText(500),
  priceAdjustment: decimalString.default("0.00"),
  preparationEffectType: z.enum(PREPARATION_EFFECT_TYPES).default("NONE"),
  preparationInstruction: optionalText(500),
});

export const updateModifierSchema = createModifierSchema.omit({ code: true }).extend({
  active: z.boolean(),
  expectedVersion,
});

export const setGroupModifierSchema = z.object({
  modifierId: z.uuid(),
  displayOrder,
  active: z.boolean().default(true),
});

export const attachGroupSchema = z.object({
  modifierGroupId: z.uuid(),
  displayOrder,
  requiredOverride: z.boolean().nullable().default(null),
  minimumOverride: z.int().min(0).max(100).nullable().default(null),
  maximumOverride: z.int().min(1).max(100).nullable().default(null),
});

export const updateAttachmentSchema = z.object({
  displayOrder,
  requiredOverride: z.boolean().nullable().default(null),
  minimumOverride: z.int().min(0).max(100).nullable().default(null),
  maximumOverride: z.int().min(1).max(100).nullable().default(null),
  active: z.boolean(),
  expectedVersion,
});

export const validateSelectionSchema = z.object({
  menuItemId: z.uuid(),
  selections: z
    .array(z.object({ modifierGroupId: z.uuid(), modifierId: z.uuid() }))
    .max(100)
    .default([]),
  locationId: z.uuid().optional(),
});

const stationCode = code;

export const createStationSchema = z.object({
  code: stationCode,
  name: requiredText(100),
  stationType: z.enum(STATION_TYPES),
  sortOrder: z.int().min(0).max(100000).default(0),
});

export const updateStationSchema = createStationSchema.omit({ code: true }).extend({
  active: z.boolean(),
  expectedVersion,
});

export const setRoutingSchema = z.object({
  /** The stations that prepare this item at the actor's location, in order. */
  prepStationIds: z.array(z.uuid()).max(10),
});

export const effectParamsSchema = z.object({ modifierId: z.uuid(), effectId: z.uuid() });

const effectFields = {
  effectType: z.enum(["ADD", "REMOVE", "ADJUST"]),
  /** Null for REMOVE. Signed for ADJUST. A decimal string; the service checks the rest. */
  quantity: decimalString.nullable().default(null),
  unitOfMeasureId: z.uuid().nullable().default(null),
};

export const addEffectSchema = z.object({
  menuItemId: z.uuid(),
  inventoryItemId: z.uuid(),
  ...effectFields,
});

export const updateEffectSchema = z.object({ ...effectFields, expectedVersion });

// Phase 17 tax configuration.
export const taxCategoryIdParamsSchema = z.object({ categoryId: z.uuid() });

export const createTaxCategorySchema = z.object({
  code,
  name: requiredText(100),
  description: optionalText(500),
});

export const updateTaxCategorySchema = createTaxCategorySchema.omit({ code: true }).extend({
  active: z.boolean(),
  expectedVersion,
});

export const changeTaxRateSchema = z.object({
  taxCategoryId: z.uuid(),
  ratePercent: decimalString,
  effectiveFrom: instant.nullable().default(null),
  expectedCurrentRateId: z.uuid().nullable().optional(),
});

export const setLocationTaxSchema = z.object({
  enabled: z.boolean(),
  expectedVersion,
});

// Phase 19: the 86 board.
export const markItemOutSchema = z.object({
  menuItemId: z.uuid(),
  reason: requiredText(200),
});

export const sellAnywaySchema = markItemOutSchema;

export const versionOnlySchema = z.object({ expectedVersion });

export const auto86SettingSchema = z.object({
  enabled: z.boolean(),
  expectedVersion,
});

export const outageIdParamsSchema = z.object({ outageId: z.uuid() });
export const overrideIdParamsSchema = z.object({ overrideId: z.uuid() });
