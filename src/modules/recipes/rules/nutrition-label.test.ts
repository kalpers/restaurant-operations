import { describe, expect, it } from "vitest";

import { displayValue, resolveNutritionLabel, type IngredientNutrition, type NutritionValues } from "./nutrition-label";

const blank: NutritionValues = {
  calories: null,
  fatG: null,
  saturatedFatG: null,
  carbohydrateG: null,
  sugarsG: null,
  fibreG: null,
  proteinG: null,
  sodiumMg: null,
};

function facts(basisQuantity: string, values: Partial<NutritionValues>): IngredientNutrition {
  return { basisQuantity, ...blank, ...values };
}

// Beef per 100 G; bun per 1 EACH; cheese per 100 G with no sodium figure.
const ingredients = new Map<string, IngredientNutrition>([
  ["beef", facts("100.0000", { calories: "250", fatG: "17", proteinG: "26", sodiumMg: "72", carbohydrateG: "0", sugarsG: "0", fibreG: "0", saturatedFatG: "7" })],
  ["bun", facts("1.0000", { calories: "150", fatG: "2.5", proteinG: "5", sodiumMg: "260", carbohydrateG: "28", sugarsG: "4", fibreG: "1", saturatedFatG: "0.5" })],
  ["cheese", facts("100.0000", { calories: "400", fatG: "33", proteinG: "25", carbohydrateG: "1.3", sugarsG: "0.5", fibreG: "0", saturatedFatG: "21" })],
]);

describe("resolveNutritionLabel", () => {
  it("sums one portion's ingredients from their base quantities", () => {
    const label = resolveNutritionLabel({
      requirements: [
        { inventoryItemId: "beef", baseQuantity: "113.4000" },
        { inventoryItemId: "bun", baseQuantity: "1.0000" },
      ],
      ingredients,
      declared: null,
    });

    // 250 x 1.134 + 150 = 433.5; protein 26 x 1.134 + 5 = 34.484.
    expect(label.source).toBe("CALCULATED");
    expect(label.complete).toBe(true);
    expect(label.figures.calories).toEqual({ value: "433.5000", display: "430", complete: true, missing: 0 });
    expect(label.figures.proteinG).toMatchObject({ value: "34.4840", display: "34" });
    expect(label.figures.sodiumMg).toMatchObject({ value: "341.6480", display: "340" });
  });

  it("marks only the figures some ingredient has no data for as incomplete, never as zero", () => {
    const label = resolveNutritionLabel({
      requirements: [
        { inventoryItemId: "bun", baseQuantity: "1.0000" },
        { inventoryItemId: "cheese", baseQuantity: "20.0000" },
        { inventoryItemId: "pickles", baseQuantity: "10.0000" },
      ],
      ingredients,
      declared: null,
    });

    expect(label.complete).toBe(false);
    // Pickles have no facts at all: every figure misses one; cheese also has no sodium.
    expect(label.figures.calories).toMatchObject({ value: "230.0000", complete: false, missing: 1 });
    expect(label.figures.sodiumMg).toMatchObject({ value: "260.0000", complete: false, missing: 2 });
  });

  it("uses declared figures instead of the recipe, blank ones staying incomplete", () => {
    const label = resolveNutritionLabel({
      requirements: [{ inventoryItemId: "beef", baseQuantity: "100.0000" }],
      ingredients,
      declared: { ...blank, calories: "140", sodiumMg: "45" },
    });

    expect(label.source).toBe("DECLARED");
    expect(label.figures.calories).toEqual({ value: "140.0000", display: "140", complete: true, missing: 0 });
    expect(label.figures.fatG).toMatchObject({ value: null, complete: false });
    expect(label.complete).toBe(false);
  });

  it("has no figures for an item with no recipe and nothing declared", () => {
    const label = resolveNutritionLabel({ requirements: null, ingredients, declared: null });

    expect(label.source).toBe("NONE");
    expect(label.figures.calories).toMatchObject({ value: null, complete: false });
  });
});

describe("displayValue (FDA rounding)", () => {
  it("rounds calories to 5 up to 50, then to 10, and below 5 to 0", () => {
    expect(displayValue("calories", "4.9")).toBe("0");
    expect(displayValue("calories", "47.4")).toBe("45");
    expect(displayValue("calories", "47.5")).toBe("50");
    expect(displayValue("calories", "433.5")).toBe("430");
    expect(displayValue("calories", "435")).toBe("440");
  });

  it("rounds fat to half grams below 5 g, then whole grams", () => {
    expect(displayValue("fatG", "0.4")).toBe("0");
    expect(displayValue("fatG", "2.3")).toBe("2.5");
    expect(displayValue("fatG", "7.6")).toBe("8");
  });

  it("rounds sodium to 5 mg up to 140, then to 10", () => {
    expect(displayValue("sodiumMg", "3")).toBe("0");
    expect(displayValue("sodiumMg", "72")).toBe("70");
    expect(displayValue("sodiumMg", "341.6")).toBe("340");
  });

  it("shows grams under 1 as <1 for carbohydrate, sugars, fibre and protein", () => {
    expect(displayValue("sugarsG", "0.4")).toBe("0");
    expect(displayValue("sugarsG", "0.7")).toBe("<1");
    expect(displayValue("proteinG", "34.484")).toBe("34");
  });
});
