import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents } from "@/db/schema";
import { loadAllergenLabels, loadBaseAllergenLabels } from "@/modules/recipes/queries/allergen-facts";
import {
  listIngredientsNeedingReview,
  setIngredientAllergens,
  setMenuItemAllergens,
  updateAllergen,
} from "@/modules/recipes/services/allergen-service";
import { AuthorizationError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { allergenList, declareAllergens, tagBurger, type AllergenList } from "../../fixtures/allergen-fixtures";
import { actorWith } from "../../fixtures/employee-fixtures";
import {
  baconCheeseburger,
  clearOrderData,
  createOrderScenario,
  plainItem,
  type Burger,
  type OrderScenario,
} from "../../fixtures/order-fixtures";

// Phase 21 policies 6 and 9-11: the allergen list, ingredient tags and review marks, declared
// allergens, and labels worked out from the recipe and modifiers.

const database = () => getDatabase();
const codes = (label: { allergens: { code: string; kind: string }[] } | undefined) =>
  label?.allergens.map((entry) => `${entry.code}:${entry.kind}`) ?? [];

describe("allergen labels (Phase 21)", () => {
  let scenario: OrderScenario;
  let burger: Burger;
  let list: AllergenList;

  beforeEach(async () => {
    scenario = await createOrderScenario(database());
    burger = await baconCheeseburger(database(), scenario);
    list = await allergenList(database(), scenario.owner);
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  it("is incomplete until every ingredient is reviewed, then lists the recipe's allergens", async () => {
    const before = await loadBaseAllergenLabels(database(), scenario.organizationId, [burger.menuItem.id], new Date());

    expect(before.get(burger.menuItem.id)).toEqual({ allergens: [], incomplete: true });
    expect((await listIngredientsNeedingReview(database(), scenario.owner)).map((row) => row.id)).toContain(
      burger.stock.bun.id,
    );

    await tagBurger(database(), scenario.owner, burger, list);

    const after = await loadBaseAllergenLabels(database(), scenario.organizationId, [burger.menuItem.id], new Date());

    expect(codes(after.get(burger.menuItem.id))).toEqual(["MILK:CONTAINS", "SESAME:CONTAINS", "WHEAT:CONTAINS"]);
    expect(after.get(burger.menuItem.id)!.incomplete).toBe(false);
    expect((await listIngredientsNeedingReview(database(), scenario.owner)).map((row) => row.id)).not.toContain(
      burger.stock.bun.id,
    );
  });

  it("follows the final ingredients, so removing the only cheese removes milk", async () => {
    await tagBurger(database(), scenario.owner, burger, list);

    const s = burger.stock;
    const labels = await loadAllergenLabels(database(), scenario.organizationId, [
      { key: "swiss", menuItemId: burger.menuItem.id, ingredientIds: [s.beef.id, s.bun.id, s.swiss.id, s.pickles.id, s.bacon.id] },
      { key: "no-cheese", menuItemId: burger.menuItem.id, ingredientIds: [s.beef.id, s.bun.id, s.bacon.id] },
    ]);

    expect(codes(labels.get("swiss"))).toContain("MILK:CONTAINS");
    expect(codes(labels.get("no-cheese"))).toEqual(["SESAME:CONTAINS", "WHEAT:CONTAINS"]);
  });

  it("labels an item with no recipe only after its declarations are reviewed", async () => {
    const fries = await plainItem(database(), scenario.owner, "4.00", "Fries");
    const label = async () =>
      (await loadBaseAllergenLabels(database(), scenario.organizationId, [fries.id], new Date())).get(fries.id);

    expect(await label()).toEqual({ allergens: [], incomplete: true });

    const saved = await declareAllergens(database(), scenario.owner, fries.id, [
      { allergenId: list.WHEAT.id, kind: "MAY_CONTAIN" },
    ]);

    expect(codes(await label())).toEqual(["WHEAT:MAY_CONTAIN"]);
    expect((await label())!.incomplete).toBe(false);

    // A second save needs the version it read.
    await expect(
      setMenuItemAllergens(database(), scenario.owner, { menuItemId: fries.id, declared: [], expectedReviewVersion: null }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
    await setMenuItemAllergens(database(), scenario.owner, {
      menuItemId: fries.id,
      declared: [],
      expectedReviewVersion: saved.reviewVersion,
    });
    expect(await label()).toEqual({ allergens: [], incomplete: false });
  });

  it("refuses a stale review, an inactive allergen and a user without the permission", async () => {
    const first = await setIngredientAllergens(database(), scenario.owner, {
      inventoryItemId: burger.stock.american.id,
      allergenIds: [list.MILK.id],
      expectedReviewVersion: null,
    });

    await expect(
      setIngredientAllergens(database(), scenario.owner, {
        inventoryItemId: burger.stock.american.id,
        allergenIds: [],
        expectedReviewVersion: null,
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);

    await updateAllergen(database(), scenario.owner, {
      allergenId: list.SESAME.id,
      name: "Sesame",
      displayOrder: 90,
      active: false,
      expectedVersion: list.SESAME.version,
    });
    await expect(
      setIngredientAllergens(database(), scenario.owner, {
        inventoryItemId: burger.stock.american.id,
        allergenIds: [list.MILK.id, list.SESAME.id],
        expectedReviewVersion: first.reviewVersion,
      }),
    ).rejects.toMatchObject({ code: "ALLERGEN_INACTIVE" });

    const clerk = await actorWith(database(), scenario, ["recipes.view", "inventory.configure"]);

    await expect(
      setIngredientAllergens(database(), clerk, {
        inventoryItemId: burger.stock.onion.id,
        allergenIds: [],
        expectedReviewVersion: null,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("audits tag changes by allergen code", async () => {
    const first = await setIngredientAllergens(database(), scenario.owner, {
      inventoryItemId: burger.stock.bun.id,
      allergenIds: [list.WHEAT.id],
      expectedReviewVersion: null,
    });

    await setIngredientAllergens(database(), scenario.owner, {
      inventoryItemId: burger.stock.bun.id,
      allergenIds: [list.WHEAT.id, list.SESAME.id],
      expectedReviewVersion: first.reviewVersion,
    });

    const [event] = await database()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "recipes.ingredient-allergens-changed"), eq(auditEvents.entityId, burger.stock.bun.id)))
      .orderBy(desc(auditEvents.occurredAt))
      .limit(1);

    expect(event).toMatchObject({
      category: "MENU",
      before: { itemCode: burger.stock.bun.code, allergenCodes: ["WHEAT"] },
      after: { itemCode: burger.stock.bun.code, allergenCodes: ["SESAME", "WHEAT"] },
    });
  });
});
