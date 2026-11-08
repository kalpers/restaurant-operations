import { describe, expect, it } from "vitest";

import {
  applyModifierEffects,
  buildSubstitution,
  parseModifierRecipeEffects,
} from "./modifier-recipe-effects";

const MENU_ITEM = "44444444-4444-4444-8444-444444444444";
const ITEM_A = "11111111-1111-4111-8111-111111111111";
const ITEM_B = "22222222-2222-4222-8222-222222222222";
const UNIT = "33333333-3333-4333-8333-333333333333";

const effect = (operation: string, extra: Record<string, unknown> = {}) => ({
  kind: "INGREDIENT",
  operation,
  menuItemId: MENU_ITEM,
  inventoryItemId: ITEM_A,
  ...(operation === "REMOVE" ? {} : { quantity: "1.5000", unitOfMeasureId: UNIT }),
  ...extra,
});

describe("modifier recipe effect contract", () => {
  it("validates ADD, REMOVE and ADJUST shapes", () => {
    expect(parseModifierRecipeEffects([effect("ADD")])).toHaveLength(1);
    expect(parseModifierRecipeEffects([effect("REMOVE")])).toHaveLength(1);
    expect(parseModifierRecipeEffects([effect("ADJUST", { quantity: "-0.5" })])).toHaveLength(1);
    expect(() => parseModifierRecipeEffects([effect("SWAP")])).toThrow(/malformed/);
  });

  it("requires a positive quantity for ADD and a non-zero one for ADJUST", () => {
    for (const quantity of ["0", "-1", "1.00001", "abc", ""]) {
      expect(() => parseModifierRecipeEffects([effect("ADD", { quantity })])).toThrow(/malformed/);
    }

    for (const quantity of ["0", "0.0000", "1.00001"]) {
      expect(() => parseModifierRecipeEffects([effect("ADJUST", { quantity })])).toThrow(/malformed/);
    }

    expect(() => parseModifierRecipeEffects([effect("ADD", { quantity: 1.5 })])).toThrow(/malformed/);
  });

  it("requires an Inventory Item and a Menu Item context", () => {
    expect(() => parseModifierRecipeEffects([effect("ADD", { inventoryItemId: "x" })])).toThrow();
    expect(() => parseModifierRecipeEffects([effect("ADD", { menuItemId: undefined })])).toThrow();
  });

  it("represents a substitution as REMOVE plus ADD", () => {
    const [removed, added] = buildSubstitution({
      menuItemId: MENU_ITEM,
      removedInventoryItemId: ITEM_A,
      added: { inventoryItemId: ITEM_B, quantity: "1.0000", unitOfMeasureId: UNIT },
    });

    expect(removed.operation).toBe("REMOVE");
    expect(added.operation).toBe("ADD");
    expect(() =>
      buildSubstitution({
        menuItemId: MENU_ITEM,
        removedInventoryItemId: ITEM_A,
        added: { inventoryItemId: ITEM_A, quantity: "1", unitOfMeasureId: UNIT },
      }),
    ).toThrow(/different one/);
  });

  it("rejects the same item changed twice for one Menu Item", () => {
    expect(() => parseModifierRecipeEffects([effect("ADD"), effect("REMOVE")])).toThrow(
      /only be changed once/,
    );
  });

  it("keeps preparation-only effects apart from ingredient changes", () => {
    const parsed = parseModifierRecipeEffects([
      { kind: "PREPARATION", instruction: "Well done" },
      effect("ADD"),
    ]);

    expect(parsed.filter((entry) => entry.kind === "INGREDIENT")).toHaveLength(1);
  });
});

describe("applyModifierEffects", () => {
  const recipe = [
    { inventoryItemId: "beef", baseQuantity: "8.0000" },
    { inventoryItemId: "onion", baseQuantity: "0.5000" },
    { inventoryItemId: "american", baseQuantity: "1.0000" },
    { inventoryItemId: "pickles", baseQuantity: "0.2500" },
  ];

  it("ADD adds a new requirement or merges with an existing one", () => {
    expect(
      applyModifierEffects(recipe, [{ operation: "ADD", inventoryItemId: "bacon", baseQuantity: "2.0000" }]),
    ).toContainEqual({ inventoryItemId: "bacon", baseQuantity: "2.0000" });
    expect(
      applyModifierEffects(recipe, [{ operation: "ADD", inventoryItemId: "beef", baseQuantity: "4.0000" }]),
    ).toContainEqual({ inventoryItemId: "beef", baseQuantity: "12.0000" });
  });

  it("REMOVE drops the requirement entirely", () => {
    const result = applyModifierEffects(recipe, [{ operation: "REMOVE", inventoryItemId: "onion" }]);

    expect(result.map((entry) => entry.inventoryItemId)).not.toContain("onion");
    expect(result).toHaveLength(3);
  });

  it("ADJUST positive and negative change the existing requirement", () => {
    const result = applyModifierEffects(recipe, [
      { operation: "ADJUST", inventoryItemId: "pickles", baseQuantity: "0.2500" },
      { operation: "ADJUST", inventoryItemId: "beef", baseQuantity: "-2.0000" },
    ]);

    expect(result).toContainEqual({ inventoryItemId: "pickles", baseQuantity: "0.5000" });
    expect(result).toContainEqual({ inventoryItemId: "beef", baseQuantity: "6.0000" });
  });

  it("drops a requirement adjusted to zero or below, and ignores items the recipe lacks", () => {
    const result = applyModifierEffects(recipe, [
      { operation: "ADJUST", inventoryItemId: "pickles", baseQuantity: "-1.0000" },
      { operation: "ADJUST", inventoryItemId: "tomato", baseQuantity: "1.0000" },
      { operation: "REMOVE", inventoryItemId: "tomato" },
    ]);

    expect(result.map((entry) => entry.inventoryItemId).sort()).toEqual(["american", "beef", "onion"]);
  });

  it("substitutes Swiss for American as REMOVE plus ADD", () => {
    const result = applyModifierEffects(recipe, [
      { operation: "REMOVE", inventoryItemId: "american" },
      { operation: "ADD", inventoryItemId: "swiss", baseQuantity: "1.0000" },
    ]);

    expect(result.map((entry) => entry.inventoryItemId)).toContain("swiss");
    expect(result.map((entry) => entry.inventoryItemId)).not.toContain("american");
  });

  it("lets REMOVE win over ADJUST for the same item, in any order", () => {
    const result = applyModifierEffects(recipe, [
      { operation: "ADJUST", inventoryItemId: "beef", baseQuantity: "2.0000" },
      { operation: "REMOVE", inventoryItemId: "beef" },
    ]);

    expect(result.map((entry) => entry.inventoryItemId)).not.toContain("beef");
  });
});
