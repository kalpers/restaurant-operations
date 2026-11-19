import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../src/db";
import { inventoryItemNutrition, inventoryItems, menuItems, pricePeriods } from "../src/db/schema";
import type { Actor } from "../src/modules/auth/types";
import { createPricePeriod } from "../src/modules/menu/services/price-period-service";
import { setIngredientNutrition } from "../src/modules/recipes/services/nutrition-service";

// Phase 28 demo data (D17): a weekday bar happy hour at MAIN and nutrition facts for the
// ingredients of a few demo dishes (the Fish Tacos, Mac & Cheese and Draft Lager labels are
// complete; the rest stay incomplete to show the marker). Local dev database only, through the
// services, and idempotent: an existing "Happy hour" or existing facts are left alone.

const HAPPY_HOUR = {
  name: "Happy hour",
  daysOfWeek: [1, 2, 3, 4, 5],
  startTime: "16:00",
  endTime: "18:00",
  orderTypes: ["BAR"],
  prices: { DRAFT_LAGER: "4.00", MARGARITA: "7.00", OLD_FASHIONED: "9.00" } as Record<string, string>,
};

type Facts = {
  basis: string;
  calories: string;
  fatG: string;
  saturatedFatG: string;
  carbohydrateG: string;
  sugarsG: string;
  fibreG: string;
  proteinG: string;
  sodiumMg: string;
};

/** Typical published figures, rounded; clearly demo data. */
const DEMO_NUTRITION: Record<string, Facts> = {
  WHITE_FISH: { basis: "4", calories: "100", fatG: "1", saturatedFatG: "0.2", carbohydrateG: "0", sugarsG: "0", fibreG: "0", proteinG: "22", sodiumMg: "60" },
  CORN_TORTILLA: { basis: "1", calories: "50", fatG: "0.7", saturatedFatG: "0.1", carbohydrateG: "10.7", sugarsG: "0.2", fibreG: "1.5", proteinG: "1.4", sodiumMg: "10" },
  CABBAGE_SLAW: { basis: "4", calories: "170", fatG: "14", saturatedFatG: "2", carbohydrateG: "11", sugarsG: "9", fibreG: "2", proteinG: "1", sodiumMg: "220" },
  ELBOW_PASTA: { basis: "2", calories: "200", fatG: "1", saturatedFatG: "0.2", carbohydrateG: "42", sugarsG: "2", fibreG: "2", proteinG: "7", sodiumMg: "0" },
  CHEDDAR_SAUCE: { basis: "2", calories: "90", fatG: "7", saturatedFatG: "3", carbohydrateG: "4", sugarsG: "1", fibreG: "0", proteinG: "2", sodiumMg: "420" },
  DRAFT_LAGER: { basis: "12", calories: "150", fatG: "0", saturatedFatG: "0", carbohydrateG: "13", sugarsG: "0", fibreG: "0", proteinG: "1.6", sodiumMg: "14" },
};

export async function seedDemoPricingAndNutrition(database: Database, pricingActor: Actor, recipesActor: Actor) {
  let periods = 0;
  const [existing] = await database
    .select({ id: pricePeriods.id })
    .from(pricePeriods)
    .where(and(eq(pricePeriods.locationId, pricingActor.locationId), eq(pricePeriods.name, HAPPY_HOUR.name)));

  if (!existing) {
    const items = await database
      .select({ id: menuItems.id, code: menuItems.code })
      .from(menuItems)
      .where(and(eq(menuItems.organizationId, pricingActor.organizationId), inArray(menuItems.code, Object.keys(HAPPY_HOUR.prices))));

    if (items.length !== Object.keys(HAPPY_HOUR.prices).length) {
      throw new Error("The demo bar drinks aren't seeded. Run `npm run db:seed:demo` again after the service history step.");
    }

    await createPricePeriod(database, pricingActor, {
      name: HAPPY_HOUR.name,
      daysOfWeek: HAPPY_HOUR.daysOfWeek,
      startTime: HAPPY_HOUR.startTime,
      endTime: HAPPY_HOUR.endTime,
      orderTypes: HAPPY_HOUR.orderTypes,
      firstDate: null,
      lastDate: null,
      items: items.map((item) => ({ menuItemId: item.id, price: HAPPY_HOUR.prices[item.code]! })),
    });
    periods += 1;
  }

  const ingredients = await database
    .select({ id: inventoryItems.id, code: inventoryItems.code })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.organizationId, recipesActor.organizationId), inArray(inventoryItems.code, Object.keys(DEMO_NUTRITION))));
  const withFacts = new Set(
    ingredients.length === 0
      ? []
      : (
          await database
            .select({ id: inventoryItemNutrition.inventoryItemId })
            .from(inventoryItemNutrition)
            .where(inArray(inventoryItemNutrition.inventoryItemId, ingredients.map((item) => item.id)))
        ).map((row) => row.id),
  );
  let facts = 0;

  for (const ingredient of ingredients) {
    if (withFacts.has(ingredient.id)) {
      continue;
    }

    const { basis, ...values } = DEMO_NUTRITION[ingredient.code]!;

    await setIngredientNutrition(database, recipesActor, {
      inventoryItemId: ingredient.id,
      basisQuantity: basis,
      values,
      expectedVersion: null,
    });
    facts += 1;
  }

  return { periods, facts };
}
