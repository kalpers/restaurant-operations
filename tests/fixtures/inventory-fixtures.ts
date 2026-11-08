import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type { Database } from "@/db";
import { locationSettings, unitsOfMeasure } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import {
  addConversion,
  createItem,
  setItemLocation,
} from "@/modules/inventory/services/item-service";
import {
  postInventoryTransaction,
  type PostingInput,
} from "@/modules/inventory/services/posting-service";
import {
  createSupplier,
  createSupplierItem,
} from "@/modules/inventory/services/supplier-service";

import { actorAt, createRoleFixture, createUserFixture } from "./auth-fixtures";
import { actorWith, createHrScenario } from "./employee-fixtures";

export const INVENTORY_ADMIN: readonly PermissionCode[] = [
  "inventory.view",
  "inventory.receive",
  "inventory.adjust",
  "inventory.count",
  "inventory.count.approve",
  "inventory.waste",
  "inventory.transfer",
  "inventory.configure",
  "inventory.cost.view",
  "purchasing.view",
  "purchasing.manage",
  "purchasing.submit",
  "suppliers.manage",
];

export const code = (prefix = "INV") =>
  `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;

export async function unitId(database: Database, unitCode: string): Promise<string> {
  const [unit] = await database
    .select({ id: unitsOfMeasure.id })
    .from(unitsOfMeasure)
    .where(eq(unitsOfMeasure.code, unitCode));

  if (!unit) {
    throw new Error(`The seeded unit ${unitCode} is missing.`);
  }

  return unit.id;
}

/** An organization with an inventory administrator at A (and at B), and narrower actors. */
export async function createInventoryScenario(database: Database) {
  const scenario = await createHrScenario(database);
  // One administrator assigned at both locations, so transfers can be authorized at each.
  const adminRole = await createRoleFixture(database, scenario.organizationId, [
    ...INVENTORY_ADMIN,
    "menu.view",
  ]);
  const adminUser = await createUserFixture(database, {
    assignments: [
      { roleId: adminRole, locationId: scenario.locationA },
      { roleId: adminRole, locationId: scenario.locationB },
    ],
  });

  return {
    ...scenario,
    admin: await actorAt(database, adminUser.id, scenario.locationA),
    // The same user and powers at location B.
    adminAtB: await actorAt(database, adminUser.id, scenario.locationB),
    // Sees stock, but not cost, and can change nothing.
    viewer: await actorWith(database, scenario, ["inventory.view"]),
    otherOrganization: (await createHrScenario(database)).owner,
    units: {
      each: await unitId(database, "EACH"),
      case: await unitId(database, "CASE"),
      bottle: await unitId(database, "BOTTLE"),
      pack: await unitId(database, "PACK"),
      slice: await unitId(database, "SLICE"),
      ml: await unitId(database, "ML"),
      l: await unitId(database, "L"),
      ozWeight: await unitId(database, "OZ_WEIGHT"),
      lb: await unitId(database, "LB"),
      flOz: await unitId(database, "FL_OZ"),
      kg: await unitId(database, "KG"),
    },
  };
}

export type InventoryScenario = Awaited<ReturnType<typeof createInventoryScenario>>;

/** An item stocked at the actor's location, with optional packaging conversions and levels. */
export async function stockedItem(
  database: Database,
  actor: Actor,
  options: {
    measurementType?: "COUNT" | "WEIGHT" | "VOLUME";
    baseUnitId: string;
    conversions?: { fromUnitId: string; toUnitId: string; factor: string }[];
    levels?: { parLevel?: string | null; reorderLevel?: string | null; reorderTarget?: string | null };
    name?: string;
    alsoAt?: Actor[];
  },
) {
  const item = await createItem(database, actor, {
    code: code("ITEM"),
    name: options.name ?? "Fixture item",
    description: null,
    measurementType: options.measurementType ?? "COUNT",
    baseUnitId: options.baseUnitId,
  });

  for (const conversion of options.conversions ?? []) {
    await addConversion(database, actor, item.id, conversion);
  }

  for (const where of [actor, ...(options.alsoAt ?? [])]) {
    await setItemLocation(database, where, item.id, {
      parLevel: options.levels?.parLevel ?? null,
      reorderLevel: options.levels?.reorderLevel ?? null,
      reorderTarget: options.levels?.reorderTarget ?? null,
      storageNote: null,
      active: true,
      expectedVersion: null,
    });
  }

  return item;
}

/** Posts one ledger movement directly, as a service-level fixture would. */
export function post(
  database: Database,
  actor: Actor,
  input: Omit<PostingInput, "organizationId" | "locationId" | "createdByUserId"> & {
    locationId?: string;
  },
) {
  return withTransaction(database, (transaction) =>
    postInventoryTransaction(transaction, {
      ...input,
      organizationId: actor.organizationId,
      locationId: input.locationId ?? actor.locationId,
      createdByUserId: actor.userId,
    }),
  );
}

export async function allowNegativeInventory(database: Database, locationId: string, allow: boolean) {
  await database
    .update(locationSettings)
    .set({ allowNegativeInventory: allow })
    .where(eq(locationSettings.locationId, locationId));
}

export async function supplierWith(
  database: Database,
  actor: Actor,
  items: { inventoryItemId: string; purchaseUnitId: string; lastUnitCost?: string | null }[],
) {
  const supplier = await createSupplier(database, actor, {
    code: code("SUP"),
    name: "Fixture supplier",
    contactName: null,
    phone: null,
    email: null,
  });
  const supplierItems = [];

  for (const item of items) {
    supplierItems.push(
      await createSupplierItem(database, actor, supplier.id, {
        inventoryItemId: item.inventoryItemId,
        purchaseUnitId: item.purchaseUnitId,
        supplierSku: null,
        lastUnitCost: item.lastUnitCost ?? null,
      }),
    );
  }

  return { supplier, supplierItems };
}
