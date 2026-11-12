import type { Database } from "@/db";
import { MAJOR_ALLERGENS } from "@/db/seeds/guest-profiles-permissions";
import type { Actor } from "@/modules/auth/types";
import { createAllergen, setIngredientAllergens, setMenuItemAllergens } from "@/modules/recipes/services/allergen-service";

import type { Burger } from "./order-fixtures";

type MajorCode = (typeof MAJOR_ALLERGENS)[number]["code"];

/** The seeded allergen list, for a fixture organization (seeds only reach the seeded one). */
export async function allergenList(database: Database, owner: Actor) {
  const rows = [];

  for (const [index, entry] of MAJOR_ALLERGENS.entries()) {
    rows.push(await createAllergen(database, owner, { ...entry, displayOrder: (index + 1) * 10 }));
  }

  return Object.fromEntries(rows.map((row) => [row.code, row])) as Record<MajorCode, (typeof rows)[number]>;
}

export type AllergenList = Awaited<ReturnType<typeof allergenList>>;

/** Tags the Bacon Cheeseburger: bun wheat and sesame, both cheeses milk, everything else reviewed with none. */
export async function tagBurger(database: Database, owner: Actor, burger: Burger, list: AllergenList) {
  const tags: [string, string[]][] = [
    [burger.stock.beef.id, []],
    [burger.stock.bun.id, [list.WHEAT.id, list.SESAME.id]],
    [burger.stock.american.id, [list.MILK.id]],
    [burger.stock.swiss.id, [list.MILK.id]],
    [burger.stock.onion.id, []],
    [burger.stock.pickles.id, []],
    [burger.stock.bacon.id, []],
  ];

  for (const [inventoryItemId, allergenIds] of tags) {
    await setIngredientAllergens(database, owner, { inventoryItemId, allergenIds, expectedReviewVersion: null });
  }
}

/** Marks an item with no recipe as reviewed, with the given declarations. */
export function declareAllergens(
  database: Database,
  owner: Actor,
  menuItemId: string,
  declared: { allergenId: string; kind: "CONTAINS" | "MAY_CONTAIN" }[] = [],
) {
  return setMenuItemAllergens(database, owner, { menuItemId, declared, expectedReviewVersion: null });
}
