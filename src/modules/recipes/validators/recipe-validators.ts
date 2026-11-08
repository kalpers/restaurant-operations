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
