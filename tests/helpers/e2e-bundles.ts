import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDatabase } from "../../src/db";
import { locations } from "../../src/db/schema";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import { saveBundleConfiguration } from "../../src/modules/menu/services/bundle-service";
import { createCategory, createItem, createMenu, createPlacement, setMenuLocation } from "../../src/modules/menu/services/catalog-service";
import { changePrice } from "../../src/modules/menu/services/pricing-service";

import type { OrdersAccount } from "./e2e-orders";

/**
 * Phase 36 E2E: "E2E Combo" at MAIN for 10.00 on its own menu: a Main course (the given burger)
 * and a Drink course (the given soda, +0.50).
 */
export async function createCombo(owner: OrdersAccount, components: { burgerId: string; sodaId: string }) {
  const database = getDatabase();
  const [main] = await database.select({ id: locations.id }).from(locations).where(eq(locations.locationCode, "MAIN"));
  const context = await getUserAuthContext(database, owner.id);
  const actor = requirePermission(context!, { permission: "menu.edit", locationId: main!.id });
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const code = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  const menu = await createMenu(database, actor, { code: code("CMB"), name: `E2E Combos ${suffix}`, description: null, displayOrder: 0 });

  await setMenuLocation(database, actor, menu.id, { locationId: main!.id, active: true });

  const category = await createCategory(database, actor, { code: code("CMB"), name: `E2E Combos ${suffix}`, description: null, displayOrder: 0 });
  const item = await createItem(database, actor, {
    code: code("COMBO"),
    name: `E2E Combo ${suffix}`,
    shortName: null,
    description: null,
    itemType: "FOOD",
    displayOrder: 0,
  });

  await changePrice(database, actor, item.id, { locationId: null, price: "10.00", effectiveFrom: null }, new Date("2024-01-01T00:00:00Z"));
  await createPlacement(database, actor, { menuId: menu.id, menuCategoryId: category.id, menuItemId: item.id, displayOrder: 0 });
  await saveBundleConfiguration(database, actor, item.id, {
    expectedVersion: item.version,
    slots: [
      { name: "Main", defaultCourse: 1, minimumChoices: 1, maximumChoices: 1, options: [{ componentMenuItemId: components.burgerId, upcharge: "0" }] },
      { name: "Drink", defaultCourse: 1, minimumChoices: 1, maximumChoices: 1, options: [{ componentMenuItemId: components.sodaId, upcharge: "0.50" }] },
    ],
  });

  return { name: item.name, categoryName: category.name };
}
