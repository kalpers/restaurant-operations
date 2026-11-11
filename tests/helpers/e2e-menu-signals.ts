import { randomUUID } from "node:crypto";

import { eq, inArray, like } from "drizzle-orm";

import { closeDatabase, getDatabase } from "../../src/db";
import { inventoryItemLocations, locations, locationSettings, unitsOfMeasure, users } from "../../src/db/schema";
import { withTransaction } from "../../src/db/transactions/transaction-context";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import type { Actor } from "../../src/modules/auth/types";
import { createItem as createInventoryItem, setItemLocation } from "../../src/modules/inventory/services/item-service";
import { postInventoryTransaction } from "../../src/modules/inventory/services/posting-service";
import { createSupplier, createSupplierItem } from "../../src/modules/inventory/services/supplier-service";
import {
  createCategory,
  createItem,
  createMenu,
  createPlacement,
  setMenuLocation,
} from "../../src/modules/menu/services/catalog-service";
import { changePrice } from "../../src/modules/menu/services/pricing-service";
import { addIngredient } from "../../src/modules/recipes/services/ingredient-service";
import { createDraftRevision, createRecipe, publishRevision } from "../../src/modules/recipes/services/recipe-service";

import { assignAt } from "./e2e-accounts";
import { createRoleAccount, uniqueCode, type E2eScope, type OrdersAccount } from "./e2e-orders";

// Phase 19 E2E: a location of this spec's own, so turning auto-86 on or 86ing items never
// touches what other specs sell at MAIN. Accounts are disabled afterwards, not deleted.

export const SIGNALS_SCOPE: E2eScope = {
  emailDomain: "signals-e2e.example.test",
  rolePrefix: "SIGNALS_E2E_",
  tablePrefix: "SIG-",
};

export type SignalsSetup = {
  locationId: string;
  owner: OrdersAccount;
  manager: OrdersAccount;
  cook: OrdersAccount;
  server: OrdersAccount;
  /** On sale, 20 portions of stock. */
  fries: { id: string; name: string };
  /** Recipe needs 1 of an ingredient with no stock: auto-86 takes it off sale. */
  special: { id: string; name: string };
  /** Reorder level 5, 6 on hand, preferred supplier set: one more out crosses the level. */
  oil: { id: string; name: string };
};

async function actorAt(account: OrdersAccount, locationId: string): Promise<Actor> {
  const context = await getUserAuthContext(getDatabase(), account.id);

  return requirePermission(context!, { permission: "menu.view", locationId });
}

async function eachUnit(): Promise<string> {
  const [row] = await getDatabase().select({ id: unitsOfMeasure.id }).from(unitsOfMeasure).where(eq(unitsOfMeasure.code, "EACH"));

  return row!.id;
}

async function account(roleCode: string, locationId: string): Promise<OrdersAccount> {
  const created = await createRoleAccount(roleCode, SIGNALS_SCOPE);

  await assignAt(created.id, roleCode, locationId);

  return created;
}

export async function createSignalsSetup(): Promise<SignalsSetup> {
  const database = getDatabase();
  const [main] = await database.select({ organizationId: locations.organizationId }).from(locations).where(eq(locations.locationCode, "MAIN"));
  const [location] = await database
    .insert(locations)
    .values({
      organizationId: main!.organizationId,
      name: `Signals ${randomUUID().slice(0, 8)}`,
      locationCode: `SIG_${randomUUID()}`,
      timezone: "America/Detroit",
    })
    .returning({ id: locations.id });
  const locationId = location!.id;

  await database.insert(locationSettings).values({ locationId, cashDrawerRequired: false });

  const owner = await account("OWNER", locationId);
  const manager = await account("MANAGER", locationId);
  const cook = await account("COOK", locationId);
  const server = await account("SERVER", locationId);
  const actor = await actorAt(owner, locationId);
  const each = await eachUnit();
  const suffix = randomUUID().slice(0, 6);
  const stocked = async (name: string, onHand: string, levels: { reorderLevel: string | null; reorderTarget: string | null }) => {
    const item = await createInventoryItem(database, actor, {
      code: uniqueCode(),
      name,
      description: null,
      measurementType: "COUNT",
      baseUnitId: each,
    });

    await setItemLocation(database, actor, item.id, {
      parLevel: levels.reorderTarget,
      reorderLevel: levels.reorderLevel,
      reorderTarget: levels.reorderTarget,
      storageNote: null,
      active: true,
      expectedVersion: null,
    });

    if (onHand !== "0") {
      await withTransaction(database, (transaction) =>
        postInventoryTransaction(transaction, {
          organizationId: actor.organizationId,
          locationId,
          inventoryItemId: item.id,
          type: "RECEIVE",
          quantity: onHand,
          unitOfMeasureId: each,
          incomingTotalCost: "10.00",
          createdByUserId: actor.userId,
        }),
      );
    }

    return item;
  };
  const potato = await stocked(`E2E Potato ${suffix}`, "20", { reorderLevel: null, reorderTarget: null });
  const truffle = await stocked(`E2E Truffle ${suffix}`, "0", { reorderLevel: null, reorderTarget: null });
  const oil = await stocked(`E2E Fryer oil ${suffix}`, "6", { reorderLevel: "5", reorderTarget: "24" });
  const supplier = await createSupplier(database, actor, {
    code: uniqueCode(),
    name: `E2E Supply ${suffix}`,
    contactName: null,
    phone: null,
    email: null,
  });
  const oilItem = await createSupplierItem(database, actor, supplier.id, {
    inventoryItemId: oil.id,
    purchaseUnitId: each,
    supplierSku: null,
    lastUnitCost: "3.0000",
  });
  const [oilConfig] = await database
    .select({ version: inventoryItemLocations.version })
    .from(inventoryItemLocations)
    .where(eq(inventoryItemLocations.inventoryItemId, oil.id));

  await setItemLocation(database, actor, oil.id, {
    parLevel: "24",
    reorderLevel: "5",
    reorderTarget: "24",
    storageNote: null,
    active: true,
    preferredSupplierItemId: oilItem.id,
    expectedVersion: oilConfig!.version,
  });

  const menu = await createMenu(database, actor, { code: uniqueCode(), name: `E2E Signals ${suffix}`, description: null, displayOrder: 0 });

  await setMenuLocation(database, actor, menu.id, { locationId, active: true });

  const category = await createCategory(database, actor, { code: uniqueCode(), name: `E2E Sides ${suffix}`, description: null, displayOrder: 0 });
  const sell = async (name: string, ingredientId: string) => {
    const item = await createItem(database, actor, {
      code: uniqueCode(),
      name,
      shortName: null,
      description: null,
      itemType: "FOOD",
      displayOrder: 0,
    });

    await changePrice(database, actor, item.id, { locationId: null, price: "5.00", effectiveFrom: null }, new Date("2024-01-01T00:00:00Z"));
    await createPlacement(database, actor, { menuId: menu.id, menuCategoryId: category.id, menuItemId: item.id, displayOrder: 0 });

    const recipe = await createRecipe(database, actor, { code: uniqueCode(), name, description: null, menuItemId: item.id });
    const draft = await createDraftRevision(database, actor, recipe.id, { yieldQuantity: "1", yieldUnitId: each, preparationNotes: null });
    const added = await addIngredient(database, actor, recipe.id, draft.id, {
      inventoryItemId: ingredientId,
      quantity: "1",
      unitOfMeasureId: each,
      preparationNote: null,
      sortOrder: 0,
      expectedVersion: draft.version,
    });

    await publishRevision(
      database,
      actor,
      recipe.id,
      draft.id,
      { effectiveFrom: null, expectedVersion: added.revisionVersion },
      new Date("2024-01-01T00:00:00Z"),
    );

    return { id: item.id, name };
  };
  const fries = await sell(`E2E Fries ${suffix}`, potato.id);
  const special = await sell(`E2E Truffle fries ${suffix}`, truffle.id);

  return { locationId, owner, manager, cook, server, fries, special, oil: { id: oil.id, name: oil.name } };
}

/** One more out of the fryer oil: 6 to 5, which crosses its reorder level of 5. */
export async function useFryerOil(setup: SignalsSetup): Promise<void> {
  const actor = await actorAt(setup.owner, setup.locationId);
  const each = await eachUnit();

  await withTransaction(getDatabase(), (transaction) =>
    postInventoryTransaction(transaction, {
      organizationId: actor.organizationId,
      locationId: setup.locationId,
      inventoryItemId: setup.oil.id,
      type: "WASTE",
      quantity: "1",
      unitOfMeasureId: each,
      reasonCode: "SPOILAGE",
      createdByUserId: actor.userId,
    }),
  );
}

export async function disableSignalsAccounts(): Promise<void> {
  const database = getDatabase();
  const accounts = await database.select({ id: users.id }).from(users).where(like(users.normalizedEmail, `%@${SIGNALS_SCOPE.emailDomain}`));

  if (accounts.length > 0) {
    await database
      .update(users)
      .set({ active: false, disabledAt: new Date() })
      .where(inArray(users.id, accounts.map((row) => row.id)));
  }

  await closeDatabase();
}
