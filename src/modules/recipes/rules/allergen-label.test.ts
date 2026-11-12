import { describe, expect, it } from "vitest";

import {
  describeConflict,
  findAllergenConflicts,
  resolveItemAllergens,
  type AllergenInfo,
  type LabelFacts,
  type RecordedAllergy,
} from "./allergen-label";

const MILK: AllergenInfo = { id: "a-milk", code: "MILK", name: "Milk" };
const WHEAT: AllergenInfo = { id: "a-wheat", code: "WHEAT", name: "Wheat" };
const SESAME: AllergenInfo = { id: "a-sesame", code: "SESAME", name: "Sesame" };
const PEANUTS: AllergenInfo = { id: "a-peanuts", code: "PEANUTS", name: "Peanuts" };
const INFO = new Map([MILK, WHEAT, SESAME, PEANUTS].map((entry) => [entry.id, entry]));

// The cheeseburger's ingredients: bun (wheat, sesame), patty, American cheese (milk), Swiss (milk), onion.
const TAGS = new Map<string, string[]>([
  ["bun", [WHEAT.id, SESAME.id]],
  ["american", [MILK.id]],
  ["swiss", [MILK.id]],
  ["patty", []],
  ["onion", []],
]);

function facts(overrides: Partial<LabelFacts>): LabelFacts {
  return {
    ingredientIds: [],
    ingredientAllergens: TAGS,
    reviewedIngredientIds: new Set(TAGS.keys()),
    declared: [],
    declarationsReviewed: false,
    allergenInfo: INFO,
    ...overrides,
  };
}

const codes = (label: ReturnType<typeof resolveItemAllergens>) =>
  label.allergens.map((entry) => `${entry.code}:${entry.kind}:${entry.source}`);

describe("resolveItemAllergens", () => {
  it("derives allergens from the final ingredients, sorted by name", () => {
    const label = resolveItemAllergens(facts({ ingredientIds: ["bun", "patty", "american", "onion"] }));

    expect(codes(label)).toEqual(["MILK:CONTAINS:DERIVED", "SESAME:CONTAINS:DERIVED", "WHEAT:CONTAINS:DERIVED"]);
    expect(label.incomplete).toBe(false);
  });

  it("follows modifiers: Swiss instead of American keeps milk, removing the bun drops wheat", () => {
    expect(codes(resolveItemAllergens(facts({ ingredientIds: ["bun", "patty", "swiss"] })))).toContain(
      "MILK:CONTAINS:DERIVED",
    );
    expect(codes(resolveItemAllergens(facts({ ingredientIds: ["patty", "american"] })))).toEqual([
      "MILK:CONTAINS:DERIVED",
    ]);
  });

  it("lets a derived CONTAINS win over a declared MAY_CONTAIN, and keeps declared ones", () => {
    const label = resolveItemAllergens(
      facts({
        ingredientIds: ["patty", "american"],
        declared: [
          { allergenId: MILK.id, kind: "MAY_CONTAIN" },
          { allergenId: PEANUTS.id, kind: "MAY_CONTAIN" },
        ],
      }),
    );

    expect(codes(label)).toEqual(["MILK:CONTAINS:DERIVED", "PEANUTS:MAY_CONTAIN:DECLARED"]);
  });

  it("is incomplete when any ingredient isn't reviewed", () => {
    const label = resolveItemAllergens(
      facts({ ingredientIds: ["bun", "patty"], reviewedIngredientIds: new Set(["bun"]) }),
    );

    expect(label.incomplete).toBe(true);
    expect(codes(label)).toEqual(["SESAME:CONTAINS:DERIVED", "WHEAT:CONTAINS:DERIVED"]);
  });

  it("is incomplete with no ingredients until the declarations are reviewed", () => {
    expect(resolveItemAllergens(facts({})).incomplete).toBe(true);
    expect(resolveItemAllergens(facts({ declarationsReviewed: true })).incomplete).toBe(false);
    expect(
      codes(resolveItemAllergens(facts({ declarationsReviewed: true, declared: [{ allergenId: WHEAT.id, kind: "CONTAINS" }] }))),
    ).toEqual(["WHEAT:CONTAINS:DECLARED"]);
  });
});

const milkAllergy: RecordedAllergy = { allergenId: MILK.id, code: "MILK", name: "Milk", severity: "ALLERGY" };
const peanutAllergy: RecordedAllergy = { allergenId: PEANUTS.id, code: "PEANUTS", name: "Peanuts", severity: "SEVERE" };

describe("findAllergenConflicts", () => {
  const burger = { itemId: "burger", label: resolveItemAllergens(facts({ ingredientIds: ["bun", "patty", "american"] })) };
  const fries = { itemId: "fries", label: resolveItemAllergens(facts({ declarationsReviewed: true })) };
  const satay = {
    itemId: "satay",
    label: resolveItemAllergens(facts({ declarationsReviewed: true, declared: [{ allergenId: PEANUTS.id, kind: "MAY_CONTAIN" }] })),
  };
  const special = { itemId: "special", label: resolveItemAllergens(facts({})) };

  it("finds nothing when the order has no allergies", () => {
    expect(findAllergenConflicts([burger, special], [])).toEqual([]);
  });

  it("matches allergens of either kind, with the highest severity", () => {
    const conflicts = findAllergenConflicts([burger, fries, satay], [milkAllergy, peanutAllergy]);

    expect(conflicts.map((entry) => [entry.itemId, entry.severity, entry.matched.map((match) => match.code)])).toEqual([
      ["burger", "ALLERGY", ["MILK"]],
      ["satay", "SEVERE", ["PEANUTS"]],
    ]);
  });

  it("treats an incomplete label as a possible conflict with every allergy", () => {
    const [conflict] = findAllergenConflicts([special], [milkAllergy, peanutAllergy]);

    expect(conflict).toMatchObject({ itemId: "special", matched: [], incompleteLabel: true, severity: "SEVERE" });
  });

  it("describes a conflict for the ticket", () => {
    const [burgerConflict, satayConflict] = findAllergenConflicts([burger, satay], [milkAllergy, peanutAllergy]);

    expect(describeConflict(burgerConflict!, [milkAllergy, peanutAllergy])).toBe("ALLERGY: Milk");
    expect(describeConflict(satayConflict!, [milkAllergy, peanutAllergy])).toBe("ALLERGY: Peanuts (severe) (may contain)");

    const [specialConflict] = findAllergenConflicts([special], [milkAllergy, peanutAllergy]);

    expect(describeConflict(specialConflict!, [milkAllergy, peanutAllergy])).toBe(
      "ALLERGY: check for Milk, Peanuts (severe); allergens not fully reviewed",
    );
  });
});
