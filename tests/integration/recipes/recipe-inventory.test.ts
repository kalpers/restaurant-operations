import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { inventoryBalances, inventoryTransactions, recipeVersionIngredients } from "@/db/schema";
import {
  addModifierEffect,
  listModifierEffects,
  removeModifierEffect,
  updateModifierEffect,
} from "@/modules/menu/services/modifier-effect-service";
import {
  addIngredient,
  copyIngredients,
  removeIngredient,
  resolveRevisionRequirements,
  updateIngredient,
} from "@/modules/recipes/services/ingredient-service";
import {
  createDraftRevision,
  createRecipe,
  deleteDraftRevision,
  getRecipeDetail,
  publishRevision,
  resolveEffectiveRevisionForMenuItem,
} from "@/modules/recipes/services/recipe-service";
import { AuthorizationError } from "@/shared/errors/app-error";

import {
  createInventoryScenario,
  stockedItem,
  type InventoryScenario,
} from "../../fixtures/inventory-fixtures";
import { attachGroupWith, itemFixture, modifierFixture, uniqueCode } from "../../fixtures/menu-fixtures";

const database = () => getDatabase();
const LONG_AGO = new Date("2024-01-01T00:00:00Z");

describe("recipe ingredients and modifier inventory effects", () => {
  let scenario: InventoryScenario;

  beforeEach(async () => {
    scenario = await createInventoryScenario(database());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  /** A burger menu item with a recipe draft, and its ingredients as Inventory Items. */
  async function burger() {
    const owner = scenario.owner;
    const beef = await stockedItem(database(), owner, { measurementType: "WEIGHT", baseUnitId: scenario.units.ozWeight });
    const bun = await stockedItem(database(), owner, { baseUnitId: scenario.units.each });
    const onion = await stockedItem(database(), owner, { measurementType: "WEIGHT", baseUnitId: scenario.units.ozWeight });
    const bacon = await stockedItem(database(), owner, { baseUnitId: scenario.units.slice });
    const menuItem = await itemFixture(database(), owner, { name: "Bacon Cheeseburger" });
    const recipe = await createRecipe(database(), owner, {
      code: uniqueCode("RCP"),
      name: "Bacon Cheeseburger",
      description: null,
      menuItemId: menuItem.id,
    });
    const draft = await createDraftRevision(database(), owner, recipe.id, {
      yieldQuantity: "1",
      yieldUnitId: scenario.units.each,
      preparationNotes: null,
    });

    return { owner, beef, bun, onion, bacon, menuItem, recipe, draft };
  }

  const ingredient = (inventoryItemId: string, quantity: string, unitOfMeasureId: string, expectedVersion: number) => ({
    inventoryItemId,
    quantity,
    unitOfMeasureId,
    preparationNote: null,
    sortOrder: 0,
    expectedVersion,
  });

  const noStockMoved = async (...itemIds: string[]) => {
    for (const id of itemIds) {
      expect(await database().select().from(inventoryTransactions).where(eq(inventoryTransactions.inventoryItemId, id))).toEqual([]);
      expect(await database().select().from(inventoryBalances).where(eq(inventoryBalances.inventoryItemId, id))).toEqual([]);
    }
  };

  describe("recipe version ingredients", () => {
    it("links a draft revision to Inventory Items with exact quantities in convertible units", async () => {
      const { owner, beef, bun, recipe, draft } = await burger();
      const first = await addIngredient(database(), owner, recipe.id, draft.id, ingredient(beef.id, "0.5", scenario.units.lb, draft.version));
      const second = await addIngredient(database(), owner, recipe.id, draft.id, ingredient(bun.id, "1", scenario.units.each, first.revisionVersion));

      expect(first.ingredient.quantity).toBe("0.5000");
      expect(second.revisionVersion).toBe(draft.version + 2);
      expect(await resolveRevisionRequirements(database(), scenario.organizationId, draft.id)).toEqual(
        expect.arrayContaining([
          { inventoryItemId: beef.id, baseQuantity: "8.0000" },
          { inventoryItemId: bun.id, baseQuantity: "1.0000" },
        ]),
      );
      await noStockMoved(beef.id, bun.id);
    });

    it("rejects a non-positive quantity, an incompatible unit, a duplicate and another organization's item", async () => {
      const { owner, beef, recipe, draft } = await burger();

      await expect(addIngredient(database(), owner, recipe.id, draft.id, ingredient(beef.id, "0", scenario.units.ozWeight, draft.version))).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
      await expect(addIngredient(database(), owner, recipe.id, draft.id, ingredient(beef.id, "1", scenario.units.ml, draft.version))).rejects.toMatchObject({ code: "NO_CONVERSION" });

      const added = await addIngredient(database(), owner, recipe.id, draft.id, ingredient(beef.id, "8", scenario.units.ozWeight, draft.version));

      await expect(addIngredient(database(), owner, recipe.id, draft.id, ingredient(beef.id, "2", scenario.units.ozWeight, added.revisionVersion))).rejects.toMatchObject({ code: "INGREDIENT_EXISTS" });

      const foreign = await stockedItem(database(), scenario.otherOrganization, { baseUnitId: scenario.units.each });

      await expect(addIngredient(database(), owner, recipe.id, draft.id, ingredient(foreign.id, "1", scenario.units.each, added.revisionVersion))).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("rejects a stale revision version", async () => {
      const { owner, beef, bun, recipe, draft } = await burger();

      await addIngredient(database(), owner, recipe.id, draft.id, ingredient(beef.id, "8", scenario.units.ozWeight, draft.version));
      await expect(addIngredient(database(), owner, recipe.id, draft.id, ingredient(bun.id, "1", scenario.units.each, draft.version))).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });
    });

    it("freezes ingredients on publish, and a new draft may change them while the old revision is kept", async () => {
      const { owner, beef, bun, recipe, draft } = await burger();
      const beefRow = await addIngredient(database(), owner, recipe.id, draft.id, ingredient(beef.id, "8", scenario.units.ozWeight, draft.version));
      const withBun = await addIngredient(database(), owner, recipe.id, draft.id, ingredient(bun.id, "1", scenario.units.each, beefRow.revisionVersion));
      const published = await publishRevision(database(), owner, recipe.id, draft.id, { effectiveFrom: null, expectedVersion: withBun.revisionVersion }, LONG_AGO);

      await expect(
        updateIngredient(database(), owner, recipe.id, draft.id, beefRow.ingredient.id, {
          quantity: "10",
          unitOfMeasureId: scenario.units.ozWeight,
          preparationNote: null,
          sortOrder: 0,
          expectedVersion: published.version,
        }),
      ).rejects.toMatchObject({ code: "REVISION_NOT_EDITABLE" });
      // The database refuses it too.
      await expect(
        database().update(recipeVersionIngredients).set({ quantity: "99" }).where(eq(recipeVersionIngredients.id, beefRow.ingredient.id)),
      ).rejects.toThrow();
      await expect(
        database().delete(recipeVersionIngredients).where(eq(recipeVersionIngredients.id, beefRow.ingredient.id)),
      ).rejects.toThrow();

      const next = await createDraftRevision(database(), owner, recipe.id, { yieldQuantity: "1", yieldUnitId: null, preparationNotes: "Double patty" });
      const copied = await copyIngredients(database(), owner, recipe.id, next.id, { fromRevisionId: draft.id, expectedVersion: next.version });

      expect(copied.copied).toBe(2);

      const detail = await getRecipeDetail(database(), owner, recipe.id);
      const nextBeef = detail.revisions.find((row) => row.id === next.id)!.ingredients.find((row) => row.inventoryItemId === beef.id)!;
      const changed = await updateIngredient(database(), owner, recipe.id, next.id, nextBeef.id, {
        quantity: "16",
        unitOfMeasureId: scenario.units.ozWeight,
        preparationNote: "Two patties",
        sortOrder: 0,
        expectedVersion: copied.revisionVersion,
      });

      await removeIngredient(database(), owner, recipe.id, next.id, detail.revisions.find((row) => row.id === next.id)!.ingredients.find((row) => row.inventoryItemId === bun.id)!.id, changed.revisionVersion);
      await publishRevision(database(), owner, recipe.id, next.id, { effectiveFrom: null, expectedVersion: changed.revisionVersion + 1 }, new Date());

      const after = await getRecipeDetail(database(), owner, recipe.id);
      const old = after.revisions.find((row) => row.id === draft.id)!;
      const current = after.revisions.find((row) => row.id === next.id)!;

      expect(old.ingredients.map((row) => [row.inventoryItemId, row.quantity]).sort()).toEqual([
        [beef.id, "8.0000"],
        [bun.id, "1.0000"],
      ].sort());
      expect(current.ingredients.map((row) => [row.inventoryItemId, row.quantity])).toEqual([[beef.id, "16.0000"]]);
      expect(after.effectiveRevisionId).toBe(next.id);

      const effectiveThen = await resolveEffectiveRevisionForMenuItem(database(), scenario.organizationId, recipe.menuItemId!, new Date("2025-01-01T00:00:00Z"));

      expect(effectiveThen?.id).toBe(draft.id);
      await noStockMoved(beef.id, bun.id);
    });

    it("discards a draft together with its ingredients", async () => {
      const { owner, beef, recipe, draft } = await burger();

      await addIngredient(database(), owner, recipe.id, draft.id, ingredient(beef.id, "8", scenario.units.ozWeight, draft.version));
      await deleteDraftRevision(database(), owner, recipe.id, draft.id);

      expect(await database().select().from(recipeVersionIngredients).where(eq(recipeVersionIngredients.recipeVersionId, draft.id))).toEqual([]);
    });

    it("requires recipes.edit", async () => {
      const { beef, recipe, draft } = await burger();

      await expect(addIngredient(database(), scenario.admin, recipe.id, draft.id, ingredient(beef.id, "1", scenario.units.ozWeight, draft.version))).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  describe("modifier inventory effects", () => {
    /** A published burger recipe with beef, onion and a bun, and modifiers offered on it. */
    async function burgerWithModifiers() {
      const setup = await burger();
      const { owner, beef, onion, bun, recipe, draft, menuItem } = setup;
      let version = draft.version;

      for (const [id, quantity, unit] of [
        [beef.id, "8", scenario.units.ozWeight],
        [onion.id, "0.5", scenario.units.ozWeight],
        [bun.id, "1", scenario.units.each],
      ] as const) {
        version = (await addIngredient(database(), owner, recipe.id, draft.id, ingredient(id, quantity, unit, version))).revisionVersion;
      }

      await publishRevision(database(), owner, recipe.id, draft.id, { effectiveFrom: null, expectedVersion: version }, LONG_AGO);

      const noOnion = await modifierFixture(database(), owner, { name: "No onion" });
      const addBacon = await modifierFixture(database(), owner, { name: "Add bacon", priceAdjustment: "2.00" });
      const extraBeef = await modifierFixture(database(), owner, { name: "Extra beef" });
      const notOffered = await modifierFixture(database(), owner, { name: "Not offered" });

      await attachGroupWith(database(), owner, menuItem.id, "OPTIONAL_MULTIPLE", [noOnion.id, addBacon.id, extraBeef.id]);

      return { ...setup, noOnion, addBacon, extraBeef, notOffered };
    }

    it("binds ADD, REMOVE and ADJUST to real Inventory Items without moving stock", async () => {
      const { owner, menuItem, onion, bacon, beef, noOnion, addBacon, extraBeef } = await burgerWithModifiers();
      const remove = await addModifierEffect(database(), owner, noOnion.id, {
        menuItemId: menuItem.id,
        inventoryItemId: onion.id,
        effectType: "REMOVE",
        quantity: null,
        unitOfMeasureId: null,
      });
      const add = await addModifierEffect(database(), owner, addBacon.id, {
        menuItemId: menuItem.id,
        inventoryItemId: bacon.id,
        effectType: "ADD",
        quantity: "2",
        unitOfMeasureId: scenario.units.slice,
      });
      const adjustUp = await addModifierEffect(database(), owner, extraBeef.id, {
        menuItemId: menuItem.id,
        inventoryItemId: beef.id,
        effectType: "ADJUST",
        quantity: "0.25",
        unitOfMeasureId: scenario.units.lb,
      });

      expect([remove.effectType, add.quantity, adjustUp.quantity]).toEqual(["REMOVE", "2.0000", "0.2500"]);

      const adjustDown = await updateModifierEffect(database(), owner, extraBeef.id, adjustUp.id, {
        effectType: "ADJUST",
        quantity: "-2",
        unitOfMeasureId: scenario.units.ozWeight,
        expectedVersion: adjustUp.version,
      });

      expect(adjustDown.quantity).toBe("-2.0000");
      expect(await listModifierEffects(database(), owner, extraBeef.id)).toHaveLength(1);
      await noStockMoved(onion.id, bacon.id, beef.id);
    });

    it("represents a substitution as REMOVE plus ADD on one modifier", async () => {
      const { owner, menuItem, onion, bacon, noOnion } = await burgerWithModifiers();

      await addModifierEffect(database(), owner, noOnion.id, { menuItemId: menuItem.id, inventoryItemId: onion.id, effectType: "REMOVE", quantity: null, unitOfMeasureId: null });
      await addModifierEffect(database(), owner, noOnion.id, { menuItemId: menuItem.id, inventoryItemId: bacon.id, effectType: "ADD", quantity: "1", unitOfMeasureId: scenario.units.slice });

      expect((await listModifierEffects(database(), owner, noOnion.id)).map((row) => row.effectType).sort()).toEqual(["ADD", "REMOVE"]);
    });

    it("rejects REMOVE or ADJUST for an item outside the recipe, bad shapes, units and contexts", async () => {
      const { owner, menuItem, bacon, beef, noOnion, notOffered } = await burgerWithModifiers();

      await expect(
        addModifierEffect(database(), owner, noOnion.id, { menuItemId: menuItem.id, inventoryItemId: bacon.id, effectType: "REMOVE", quantity: null, unitOfMeasureId: null }),
      ).rejects.toMatchObject({ code: "NOT_A_RECIPE_INGREDIENT" });
      await expect(
        addModifierEffect(database(), owner, noOnion.id, { menuItemId: menuItem.id, inventoryItemId: beef.id, effectType: "REMOVE", quantity: "1", unitOfMeasureId: scenario.units.ozWeight }),
      ).rejects.toMatchObject({ code: "INVALID_RECIPE_EFFECT" });
      await expect(
        addModifierEffect(database(), owner, noOnion.id, { menuItemId: menuItem.id, inventoryItemId: beef.id, effectType: "ADD", quantity: "-1", unitOfMeasureId: scenario.units.ozWeight }),
      ).rejects.toMatchObject({ code: "INVALID_RECIPE_EFFECT" });
      await expect(
        addModifierEffect(database(), owner, noOnion.id, { menuItemId: menuItem.id, inventoryItemId: beef.id, effectType: "ADJUST", quantity: "0", unitOfMeasureId: scenario.units.ozWeight }),
      ).rejects.toMatchObject({ code: "INVALID_RECIPE_EFFECT" });
      await expect(
        addModifierEffect(database(), owner, noOnion.id, { menuItemId: menuItem.id, inventoryItemId: beef.id, effectType: "ADD", quantity: "1", unitOfMeasureId: scenario.units.ml }),
      ).rejects.toMatchObject({ code: "NO_CONVERSION" });
      await expect(
        addModifierEffect(database(), owner, notOffered.id, { menuItemId: menuItem.id, inventoryItemId: bacon.id, effectType: "ADD", quantity: "1", unitOfMeasureId: scenario.units.slice }),
      ).rejects.toMatchObject({ code: "MODIFIER_NOT_ON_ITEM" });

      const foreign = await stockedItem(database(), scenario.otherOrganization, { baseUnitId: scenario.units.each });

      await expect(
        addModifierEffect(database(), owner, noOnion.id, { menuItemId: menuItem.id, inventoryItemId: foreign.id, effectType: "ADD", quantity: "1", unitOfMeasureId: scenario.units.each }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("prevents two effects on one item for one menu item, and removes configuration cleanly", async () => {
      const { owner, menuItem, bacon, addBacon } = await burgerWithModifiers();
      const input = { menuItemId: menuItem.id, inventoryItemId: bacon.id, effectType: "ADD" as const, quantity: "1", unitOfMeasureId: scenario.units.slice };
      const effect = await addModifierEffect(database(), owner, addBacon.id, input);

      await expect(addModifierEffect(database(), owner, addBacon.id, input)).rejects.toMatchObject({ code: "EFFECT_EXISTS" });
      await removeModifierEffect(database(), owner, addBacon.id, effect.id);
      expect(await listModifierEffects(database(), owner, addBacon.id)).toEqual([]);
    });

    it("requires menu.modifiers.manage", async () => {
      const { menuItem, bacon, addBacon } = await burgerWithModifiers();

      await expect(
        addModifierEffect(database(), scenario.admin, addBacon.id, { menuItemId: menuItem.id, inventoryItemId: bacon.id, effectType: "ADD", quantity: "1", unitOfMeasureId: scenario.units.slice }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    });
  });
});
