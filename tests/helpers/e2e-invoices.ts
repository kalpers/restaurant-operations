import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDatabase } from "../../src/db";
import { unitsOfMeasure } from "../../src/db/schema";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import { addConversion, createItem, setItemLocation } from "../../src/modules/inventory/services/item-service";
import { addPurchaseOrderLine, createPurchaseOrder, submitPurchaseOrder } from "../../src/modules/inventory/services/purchase-order-service";
import { receivePurchaseOrder } from "../../src/modules/inventory/services/receiving-service";
import { createSupplier, createSupplierItem } from "../../src/modules/inventory/services/supplier-service";

import type { BriefingsSetup } from "./e2e-briefings";

/** Phase 36 E2E: a supplier, an item, and ten cases ordered at 24.00 and received at that cost. */
export async function createReceivedDelivery(setup: BriefingsSetup): Promise<{ supplierName: string; itemName: string }> {
  const database = getDatabase();
  const context = await getUserAuthContext(database, setup.owner.id);
  const owner = requirePermission(context!, { permission: "inventory.configure", locationId: setup.locationId });
  const unit = async (code: string) =>
    (await database.select({ id: unitsOfMeasure.id }).from(unitsOfMeasure).where(eq(unitsOfMeasure.code, code)))[0]!.id;
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const itemName = `Lemons ${suffix}`;
  const supplierName = `Citrus Co ${suffix}`;
  const item = await createItem(database, owner, {
    code: `LEM_${suffix}`,
    name: itemName,
    description: null,
    measurementType: "COUNT",
    baseUnitId: await unit("EACH"),
  });

  await addConversion(database, owner, item.id, { fromUnitId: await unit("CASE"), toUnitId: await unit("EACH"), factor: "100" });
  await setItemLocation(database, owner, item.id, {
    parLevel: null,
    reorderLevel: null,
    reorderTarget: null,
    storageNote: null,
    active: true,
    expectedVersion: null,
  });

  const supplier = await createSupplier(database, owner, { code: `CIT_${suffix}`, name: supplierName, contactName: null, phone: null, email: null });
  const supplierItem = await createSupplierItem(database, owner, supplier.id, {
    inventoryItemId: item.id,
    purchaseUnitId: await unit("CASE"),
    supplierSku: null,
    lastUnitCost: "24.0000",
  });
  const order = await createPurchaseOrder(database, owner, { supplierId: supplier.id, expectedAt: null, notes: null });
  const line = await addPurchaseOrderLine(database, owner, order.id, {
    supplierItemId: supplierItem.id,
    orderedQuantity: "10",
    unitPrice: null,
    expectedVersion: order.version,
  });

  await submitPurchaseOrder(database, owner, order.id, order.version + 1);
  await receivePurchaseOrder(database, owner, order.id, {
    lines: [{ purchaseOrderLineId: line.id, receivedQuantity: "10", actualUnitCost: null }],
    supplierReference: "DN-1",
    notes: null,
  });

  return { supplierName, itemName };
}
