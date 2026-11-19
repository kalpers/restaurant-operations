import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { quoteNutrition } from "@/modules/menu/services/nutrition-quote-service";
import { loadBaseNutritionLabels } from "@/modules/recipes/queries/nutrition-facts";
import { setIngredientNutrition, setMenuItemNutrition } from "@/modules/recipes/services/nutrition-service";

import { actorWith } from "../../fixtures/employee-fixtures";
import {
  baconCheeseburger,
  clearOrderData,
  createOrderScenario,
  SERVER_ORDER_PERMISSIONS,
  type Burger,
  type OrderScenario,
} from "../../fixtures/order-fixtures";

const database = () => getDatabase();

/** Figures for one basis amount: the calories given, every other figure 1. */
const figures = (calories: string) => ({
  calories,
  fatG: "1",
  saturatedFatG: "1",
  carbohydrateG: "1",
  sugarsG: "1",
  fibreG: "1",
  proteinG: "1",
  sodiumMg: "1",
});

describe("nutrition (Phase 28)", () => {
  let scenario: OrderScenario;
  let burger: Burger;
  let editor: Actor;
  let server: Actor;

  const base = async () =>
    (await loadBaseNutritionLabels(database(), scenario.organizationId, [burger.menuItem.id], new Date())).get(burger.menuItem.id)!;

  beforeAll(async () => {
    scenario = await createOrderScenario(database());
    burger = await baconCheeseburger(database(), scenario);
    editor = await actorWith(database(), scenario, ["recipes.edit"]);
    server = await actorWith(database(), scenario, SERVER_ORDER_PERMISSIONS);
  }, 120_000);

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  it("marks every figure incomplete, never zero, while ingredients have no data", async () => {
    const label = await base();

    expect(label.source).toBe("CALCULATED");
    expect(label.complete).toBe(false);
    expect(label.figures.calories).toMatchObject({ value: null, display: null, complete: false, missing: 6 });

    // Beef only: 0.5 LB is 8 OZ_WEIGHT; 280 per 4 oz.
    await setIngredientNutrition(database(), editor, {
      inventoryItemId: burger.stock.beef.id,
      basisQuantity: "4",
      values: figures("280"),
      expectedVersion: null,
    });

    expect((await base()).figures.calories).toMatchObject({ value: "560.0000", complete: false, missing: 5 });
  });

  it("sums the recipe, and the order screen's quote applies the chosen modifiers as SEND does", async () => {
    for (const [item, calories] of [
      [burger.stock.bun, "180"],
      [burger.stock.american, "70"],
      [burger.stock.swiss, "100"],
      [burger.stock.onion, "5"],
      [burger.stock.pickles, "1"],
      [burger.stock.bacon, "45"],
    ] as const) {
      await setIngredientNutrition(database(), editor, {
        inventoryItemId: item.id,
        basisQuantity: "1",
        values: figures(calories),
        expectedVersion: null,
      });
    }

    // 560 + 180 + 70 + 5 + 3 x 1 + 2 x 45 = 908.
    const label = await base();

    expect(label.complete).toBe(true);
    expect(label.figures.calories).toEqual({ value: "908.0000", display: "910", complete: true, missing: 0 });

    // Medium, No Onion, Extra Pickles (5), Swiss instead of American: 560 + 180 + 100 + 5 + 90 = 935.
    const quote = await quoteNutrition(database(), server, {
      menuItemId: burger.menuItem.id,
      selections: burger.canonicalSelections,
    });

    expect(quote.figures.calories).toMatchObject({ value: "935.0000", display: "940", complete: true });
    // Sodium, 1 per basis: beef 8 oz / 4 = 2, bun 1, Swiss 1, pickles 5, bacon 2.
    expect(quote.figures.sodiumMg.value).toBe("11.0000");
  });

  it("uses declared figures instead of the recipe until they are removed", async () => {
    const declared = await setMenuItemNutrition(database(), editor, {
      menuItemId: burger.menuItem.id,
      values: { calories: "750" },
      expectedVersion: null,
    });
    const label = await base();

    expect(label.source).toBe("DECLARED");
    expect(label.figures.calories).toMatchObject({ value: "750.0000", display: "750", complete: true });
    expect(label.figures.fatG).toMatchObject({ value: null, complete: false });

    await setMenuItemNutrition(database(), editor, {
      menuItemId: burger.menuItem.id,
      values: {},
      remove: true,
      expectedVersion: declared.version,
    });

    expect((await base()).source).toBe("CALCULATED");
  });

  it("checks the version, audits field names only, and needs recipes.edit", async () => {
    await expect(
      setIngredientNutrition(database(), editor, {
        inventoryItemId: burger.stock.bun.id,
        basisQuantity: "1",
        values: figures("190"),
        expectedVersion: null,
      }),
    ).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });

    const updated = await setIngredientNutrition(database(), editor, {
      inventoryItemId: burger.stock.bun.id,
      basisQuantity: "1",
      values: figures("190"),
      expectedVersion: 1,
    });

    expect(updated.version).toBe(2);

    const audits = await database()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "recipes.ingredient-nutrition-changed"), eq(auditEvents.entityId, burger.stock.bun.id)));
    const last = audits.at(-1)!;

    expect(last.details).toEqual({ itemCode: expect.any(String), changedFields: ["calories"] });
    expect(JSON.stringify(audits)).not.toContain("190");

    await expect(
      setIngredientNutrition(database(), server, {
        inventoryItemId: burger.stock.bun.id,
        basisQuantity: "1",
        values: figures("1"),
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ name: "AuthorizationError" });
    await expect(
      setIngredientNutrition(database(), editor, {
        inventoryItemId: burger.stock.bun.id,
        basisQuantity: "0",
        values: figures("1"),
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "INVALID_BASIS" });
  });
});
