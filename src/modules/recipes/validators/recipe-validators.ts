import { z } from "zod";

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
/** A decimal string, never coerced to a number. The service checks its scale and sign. */
const decimalString = z.string().trim().regex(/^-?\d+(\.\d+)?$/);
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const recipeIdParamsSchema = z.object({ recipeId: z.uuid() });
export const revisionParamsSchema = z.object({
  recipeId: z.uuid(),
  revisionId: z.uuid(),
});

export const createRecipeSchema = z.object({
  code,
  name: requiredText(120),
  description: optionalText(500),
  menuItemId: z.uuid().nullable().default(null),
});

export const updateRecipeSchema = createRecipeSchema.omit({ code: true }).extend({
  active: z.boolean(),
  expectedVersion,
});

const draftFields = {
  yieldQuantity: decimalString,
  yieldUnitId: z.uuid().nullable().default(null),
  preparationNotes: optionalText(4000),
};

export const createDraftSchema = z.object(draftFields);
export const updateDraftSchema = z.object({ ...draftFields, expectedVersion });

export const publishRevisionSchema = z.object({
  /** Null means now. A given start can't be in the past. */
  effectiveFrom: instant.nullable().default(null),
  expectedVersion,
});

export const retireRevisionSchema = z.object({ expectedVersion });

export const convertUnitsSchema = z.object({
  quantity: decimalString,
  fromUnit: z.string().trim().min(1).max(20),
  toUnit: z.string().trim().min(1).max(20),
});

export const ingredientParamsSchema = z.object({
  recipeId: z.uuid(),
  revisionId: z.uuid(),
  ingredientId: z.uuid(),
});

const ingredientFields = {
  quantity: decimalString,
  unitOfMeasureId: z.uuid(),
  preparationNote: optionalText(300),
  sortOrder: z.int().min(0).max(100000).default(0),
  /** The revision's version, which every ingredient change checks and bumps. */
  expectedVersion,
};

export const addIngredientSchema = z.object({ inventoryItemId: z.uuid(), ...ingredientFields });
export const updateIngredientSchema = z.object(ingredientFields);
export const removeIngredientSchema = z.object({ expectedVersion });
export const copyIngredientsSchema = z.object({ fromRevisionId: z.uuid(), expectedVersion });

// Phase 21 allergen setup (policies 6, 9, 10).
const allergenCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{0,39}$/, "Start with a letter; use capital letters, digits and underscores.");
const reviewVersion = z.int().positive().nullable();

export const allergenIdParamsSchema = z.object({ allergenId: z.uuid() });

export const createAllergenSchema = z.object({
  code: allergenCode,
  name: requiredText(60),
  displayOrder: z.int().min(0).max(9999).default(0),
});

export const updateAllergenSchema = z.object({
  name: requiredText(60),
  displayOrder: z.int().min(0).max(9999),
  active: z.boolean(),
  expectedVersion,
});

export const setIngredientAllergensSchema = z.object({
  allergenIds: z.array(z.uuid()).max(50),
  expectedReviewVersion: reviewVersion,
});

export const setMenuItemAllergensSchema = z.object({
  declared: z
    .array(z.object({ allergenId: z.uuid(), kind: z.enum(["CONTAINS", "MAY_CONTAIN"]) }))
    .max(50),
  expectedReviewVersion: reviewVersion,
});
