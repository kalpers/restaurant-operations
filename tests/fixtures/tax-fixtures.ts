import { eq } from "drizzle-orm";

import type { Database } from "@/db";
import { menuItems } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import {
  changeTaxRate,
  createTaxCategory,
  getLocationTaxSetting,
  setLocationTaxEnabled,
} from "@/modules/menu/services/tax-service";

import { uniqueCode } from "./menu-fixtures";

/** Turns tax on (or off) at the actor's Location. */
export async function setTax(database: Database, actor: Actor, enabled: boolean) {
  const { version } = await getLocationTaxSetting(database, actor);

  return setLocationTaxEnabled(database, actor, { enabled, expectedVersion: version });
}

/** A Tax Category with a rate in force from now at the actor's Location. */
export async function taxCategoryWithRate(database: Database, actor: Actor, ratePercent: string, code = uniqueCode("TAX")) {
  const category = await createTaxCategory(database, actor, { code, name: `Tax ${code}`, description: null });
  const rate = await changeTaxRate(database, actor, { taxCategoryId: category.id, ratePercent, effectiveFrom: null });

  return { category, rate };
}

/** Assigns (or clears) a menu item's Tax Category directly. */
export async function assignTaxCategory(database: Database, menuItemId: string, taxCategoryId: string | null) {
  await database.update(menuItems).set({ taxCategoryId }).where(eq(menuItems.id, menuItemId));
}
