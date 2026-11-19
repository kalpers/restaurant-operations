import { NUTRITION_FIGURES, type NutritionFigure } from "@/shared/nutrition/figures";
import {
  addDecimals,
  compareDecimals,
  divideRoundHalfUp,
  multiplyExact,
  toScale,
} from "@/shared/decimal/decimal";

// Phase 28 nutrition label (policies 11 and 12). Pure. A label is worked out from what one
// portion takes after the chosen modifiers (the SEND rule), or replaced by figures the item
// declares. A figure any ingredient has no data for is incomplete and never shown as a whole
// number, just as an unreviewed allergen never reads as "free". Stored values stay exact;
// display follows the FDA label rounding rules.

export { NUTRITION_FIGURES, type NutritionFigure };

export type NutritionValues = Record<NutritionFigure, string | null>;

export type IngredientNutrition = { basisQuantity: string } & NutritionValues;

export type FigureResult = {
  /** Exact sum to four places; with missing data, the sum of what is known. */
  value: string | null;
  /** FDA-rounded text, e.g. "350" or "<1"; null with no data at all. */
  display: string | null;
  complete: boolean;
  /** Ingredients with a quantity and no value for this figure. */
  missing: number;
};

export type NutritionLabel = {
  source: "DECLARED" | "CALCULATED" | "NONE";
  figures: Record<NutritionFigure, FigureResult>;
  complete: boolean;
};

export const FIGURE_LABELS: Record<NutritionFigure, { name: string; unit: string }> = {
  calories: { name: "Calories", unit: "" },
  fatG: { name: "Total fat", unit: "g" },
  saturatedFatG: { name: "Saturated fat", unit: "g" },
  carbohydrateG: { name: "Carbohydrate", unit: "g" },
  sugarsG: { name: "Sugars", unit: "g" },
  fibreG: { name: "Fibre", unit: "g" },
  proteinG: { name: "Protein", unit: "g" },
  sodiumMg: { name: "Sodium", unit: "mg" },
};

function nearest(value: string, step: string): string {
  return multiplyExact(divideRoundHalfUp(value, step, 0), step);
}

function trim(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

/** FDA display rounding (21 CFR 101.9) for each figure. */
export function displayValue(figure: NutritionFigure, value: string): string {
  const below = (limit: string) => compareDecimals(value, limit) < 0;

  switch (figure) {
    case "calories":
      return below("5") ? "0" : trim(nearest(value, compareDecimals(value, "50") <= 0 ? "5" : "10"));
    case "fatG":
    case "saturatedFatG":
      return below("0.5") ? "0" : trim(below("5") ? nearest(value, "0.5") : nearest(value, "1"));
    case "sodiumMg":
      return below("5") ? "0" : trim(compareDecimals(value, "140") <= 0 ? nearest(value, "5") : nearest(value, "10"));
    default:
      return below("0.5") ? "0" : below("1") ? "<1" : trim(nearest(value, "1"));
  }
}

export function resolveNutritionLabel(input: {
  /** One portion's ingredients after modifiers, in base units; null when there is no recipe. */
  requirements: readonly { inventoryItemId: string; baseQuantity: string }[] | null;
  ingredients: ReadonlyMap<string, IngredientNutrition>;
  declared: NutritionValues | null;
}): NutritionLabel {
  const figures = {} as Record<NutritionFigure, FigureResult>;

  if (input.declared) {
    for (const figure of NUTRITION_FIGURES) {
      const value = input.declared[figure];

      // A declared figure left blank is missing data, so the label is incomplete.
      figures[figure] = {
        value: value === null ? null : toScale(value, 4),
        display: value === null ? null : displayValue(figure, value),
        complete: value !== null,
        missing: value === null ? 1 : 0,
      };
    }

    return { source: "DECLARED", figures, complete: NUTRITION_FIGURES.every((figure) => figures[figure].complete) };
  }

  const requirements = (input.requirements ?? []).filter((entry) => compareDecimals(entry.baseQuantity, "0") > 0);

  if (requirements.length === 0) {
    for (const figure of NUTRITION_FIGURES) {
      figures[figure] = { value: null, display: null, complete: false, missing: 0 };
    }

    return { source: "NONE", figures, complete: false };
  }

  for (const figure of NUTRITION_FIGURES) {
    let total = "0.0000";
    let missing = 0;
    let known = 0;

    for (const requirement of requirements) {
      const facts = input.ingredients.get(requirement.inventoryItemId);
      const perBasis = facts?.[figure] ?? null;

      if (!facts || perBasis === null) {
        missing += 1;
        continue;
      }

      known += 1;
      total = addDecimals(total, divideRoundHalfUp(multiplyExact(requirement.baseQuantity, perBasis), facts.basisQuantity, 4));
    }

    const value = known === 0 ? null : toScale(total, 4);

    figures[figure] = {
      value,
      // Incomplete figures show what is known only as "at least", which the screen words.
      display: value === null ? null : displayValue(figure, value),
      complete: missing === 0,
      missing,
    };
  }

  return { source: "CALCULATED", figures, complete: NUTRITION_FIGURES.every((figure) => figures[figure].complete) };
}
