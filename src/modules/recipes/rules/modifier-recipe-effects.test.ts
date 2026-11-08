import { describe, expect, it } from "vitest";

import {
  buildSubstitution,
  ingredientDeltasOf,
  parseModifierRecipeEffects,
} from "./modifier-recipe-effects";

const ITEM_A = "11111111-1111-4111-8111-111111111111";
const ITEM_B = "22222222-2222-4222-8222-222222222222";
const UNIT = "33333333-3333-4333-8333-333333333333";

const ingredient = (operation: string, extra: Record<string, unknown> = {}) => ({
  kind: "INGREDIENT",
  operation,
  inventoryItemId: ITEM_A,
  quantity: "1.5000",
  unitOfMeasureId: UNIT,
  ...extra,
});

describe("modifier recipe effects", () => {
  it("validates ADD, REMOVE and ADJUST payloads", () => {
    const parsed = parseModifierRecipeEffects([
      ingredient("ADD"),
      ingredient("REMOVE", { inventoryItemId: ITEM_B }),
    ]);

    expect(parsed).toHaveLength(2);
    expect(() =>
      parseModifierRecipeEffects([ingredient("ADJUST", { direction: "INCREASE" })]),
    ).not.toThrow();
    expect(() => parseModifierRecipeEffects([ingredient("ADJUST")])).toThrow(/malformed/);
    expect(() => parseModifierRecipeEffects([ingredient("SWAP")])).toThrow(/malformed/);
  });

  it("requires a positive exact decimal-string quantity", () => {
    for (const quantity of ["0", "-1", "1.00001", "abc", ""]) {
      expect(() => parseModifierRecipeEffects([ingredient("ADD", { quantity })])).toThrow(
        /malformed/,
      );
    }

    expect(() => parseModifierRecipeEffects([ingredient("ADD", { quantity: 1.5 })])).toThrow(
      /malformed/,
    );
  });

  it("requires an Inventory Item identity", () => {
    expect(() =>
      parseModifierRecipeEffects([ingredient("ADD", { inventoryItemId: "not-a-uuid" })]),
    ).toThrow(/malformed/);
    expect(() =>
      parseModifierRecipeEffects([ingredient("ADD", { inventoryItemId: undefined })]),
    ).toThrow(/malformed/);
  });

  it("represents a substitution as a REMOVE plus an ADD", () => {
    const [removed, added] = buildSubstitution({
      removed: { inventoryItemId: ITEM_A, quantity: "1.0000", unitOfMeasureId: UNIT },
      added: { inventoryItemId: ITEM_B, quantity: "1.0000", unitOfMeasureId: UNIT },
    });

    expect(removed.operation).toBe("REMOVE");
    expect(added.operation).toBe("ADD");
    expect(() =>
      buildSubstitution({
        removed: { inventoryItemId: ITEM_A, quantity: "1", unitOfMeasureId: UNIT },
        added: { inventoryItemId: ITEM_A, quantity: "1", unitOfMeasureId: UNIT },
      }),
    ).toThrow(/different one/);
  });

  it("rejects the same item changed twice in one context", () => {
    expect(() =>
      parseModifierRecipeEffects([ingredient("ADD"), ingredient("REMOVE")]),
    ).toThrow(/only be changed once/);
  });

  it("never turns a preparation-only effect into an ingredient delta", () => {
    const effects = parseModifierRecipeEffects([
      { kind: "PREPARATION", instruction: "Cook well done" },
      ingredient("ADD"),
      ingredient("ADJUST", { inventoryItemId: ITEM_B, direction: "DECREASE" }),
    ]);
    const deltas = ingredientDeltasOf(effects);

    expect(deltas).toHaveLength(2);
    expect(deltas.map((delta) => delta.direction)).toEqual(["ADD", "REMOVE"]);
    expect(ingredientDeltasOf(parseModifierRecipeEffects([{ kind: "PREPARATION", instruction: "Well done" }]))).toEqual([]);
    expect(() =>
      parseModifierRecipeEffects([
        { kind: "PREPARATION", instruction: "x", inventoryItemId: ITEM_A, quantity: "1" },
      ]),
    ).not.toThrow();
    expect(
      ingredientDeltasOf(
        parseModifierRecipeEffects([
          { kind: "PREPARATION", instruction: "x", inventoryItemId: ITEM_A, quantity: "1" },
        ]),
      ),
    ).toEqual([]);
  });
});
