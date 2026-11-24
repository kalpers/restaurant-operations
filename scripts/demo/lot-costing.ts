import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { Database } from "../../src/db";
import { inventoryItems, supplierItems } from "../../src/db/schema";
import type { Actor } from "../../src/modules/auth/types";
import { changeCostingMethod } from "../../src/modules/inventory/services/costing-method-service";
import { enableLotTracking } from "../../src/modules/inventory/services/lot-service";
import { addPurchaseOrderLine, createPurchaseOrder, submitPurchaseOrder } from "../../src/modules/inventory/services/purchase-order-service";
import { receivePurchaseOrder } from "../../src/modules/inventory/services/receiving-service";
import { multiplyExact, roundHalfUp } from "../../src/shared/decimal/decimal";
import { addDays } from "../../src/shared/time/zoned-time";

// Phase 37 (D13): the mozzarella at MAIN is costed by lot. Two deliveries arrive this morning at
// different prices (the second case cost 12% more), each a dated lot carried at its own cost,
// before tonight's tables send pizzas that use them. Runs only while the mozzarella is still
// weighted average, so a rerun adds nothing. Local dev DB only.

export async function seedDemoLotCosting(database: Database, owner: Actor, today: string): Promise<string> {
  const [mozzarella] = await database
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.organizationId, owner.organizationId), eq(inventoryItems.code, "MOZZARELLA")));

  if (!mozzarella) {
    return "no mozzarella to cost by lot";
  }

  if (mozzarella.costingMethod === "LOT") {
    return "mozzarella already costed by lot";
  }

  let version = mozzarella.version;

  if (!mozzarella.lotTracked) {
    version = (await enableLotTracking(database, owner, mozzarella.id, version)).version;
  }

  await changeCostingMethod(database, owner, mozzarella.id, { method: "LOT", reasonCode: "SUPPLIER_PRICES_VARY", expectedVersion: version });

  const [supplierItem] = await database
    .select({ id: supplierItems.id, supplierId: supplierItems.supplierId, cost: supplierItems.lastUnitCost })
    .from(supplierItems)
    .where(and(eq(supplierItems.inventoryItemId, mozzarella.id), eq(supplierItems.active, true)))
    .limit(1);

  if (!supplierItem?.cost) {
    return "mozzarella costed by lot (no supplier price for the deliveries)";
  }

  // One case each: the usual price, use within two days; then 12% more, use within twelve.
  for (const [factor, days] of [["1", 2], ["1.12", 12]] as const) {
    const order = await createPurchaseOrder(database, owner, { supplierId: supplierItem.supplierId, expectedAt: new Date(), notes: "Morning cheese delivery (demo)." });
    const line = await addPurchaseOrderLine(database, owner, order.id, { supplierItemId: supplierItem.id, orderedQuantity: "1", unitPrice: null, expectedVersion: order.version });

    await submitPurchaseOrder(database, owner, order.id, order.version + 1);
    await receivePurchaseOrder(database, owner, order.id, {
      lines: [
        {
          purchaseOrderLineId: line.id,
          receivedQuantity: "1",
          actualUnitCost: roundHalfUp(multiplyExact(supplierItem.cost, factor), 4),
          expiresOn: addDays(today, days),
          supplierLotCode: `MZ-${randomUUID().slice(0, 4).toUpperCase()}`,
        },
      ],
      supplierReference: `INV-${randomUUID().slice(0, 6).toUpperCase()}`,
      notes: null,
    });
  }

  return "mozzarella costed by lot, with two deliveries at different prices";
}
