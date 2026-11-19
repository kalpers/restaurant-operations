// Phase 28 (policy 11): the nutrition figures, shared by the schema, the label rule and the
// screens. US label core figures; grams except calories and sodium (mg).
export const NUTRITION_FIGURES = [
  "calories",
  "fatG",
  "saturatedFatG",
  "carbohydrateG",
  "sugarsG",
  "fibreG",
  "proteinG",
  "sodiumMg",
] as const;

export type NutritionFigure = (typeof NUTRITION_FIGURES)[number];
