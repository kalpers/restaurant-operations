import { and, count, eq, inArray, or } from "drizzle-orm";

import { inventoryItemLocations, inventoryTransfers, purchaseOrders } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";

/**
 * Phase 23 (policy 2, D2 `STOCKED_ITEMS`): the items stocked at the source, with their
 * par, reorder levels, preferred supplier and storage note. No stock moves: the new
 * location's balances start at zero when something is first posted there.
 */
export async function copyStockedItems(
  transaction: DatabaseTransaction,
  input: { organizationId: string; fromLocationId: string; toLocationId: string },
): Promise<number> {
  const stocked = await transaction
    .select()
    .from(inventoryItemLocations)
    .where(and(eq(inventoryItemLocations.locationId, input.fromLocationId), eq(inventoryItemLocations.active, true)));

  if (stocked.length > 0) {
    await transaction.insert(inventoryItemLocations).values(
      stocked.map((row) => ({
        organizationId: input.organizationId,
        inventoryItemId: row.inventoryItemId,
        locationId: input.toLocationId,
        parLevel: row.parLevel,
        reorderLevel: row.reorderLevel,
        reorderTarget: row.reorderTarget,
        preferredSupplierItemId: row.preferredSupplierItemId,
        storageNote: row.storageNote,
      })),
    );
  }

  return stocked.length;
}

/** Phase 23 (policy 3): inventory work that would be stranded if the location closed. */
export async function findOpenInventoryWork(
  transaction: DatabaseTransaction,
  locationId: string,
): Promise<string[]> {
  const [orders] = await transaction
    .select({ total: count() })
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.locationId, locationId),
        inArray(purchaseOrders.status, ["SUBMITTED", "PARTIALLY_RECEIVED"]),
      ),
    );

  const [transfers] = await transaction
    .select({ total: count() })
    .from(inventoryTransfers)
    .where(
      and(
        eq(inventoryTransfers.status, "SENT"),
        or(eq(inventoryTransfers.fromLocationId, locationId), eq(inventoryTransfers.toLocationId, locationId)),
      ),
    );

  return [
    ...((orders?.total ?? 0) > 0 ? ["purchase orders still to be received"] : []),
    ...((transfers?.total ?? 0) > 0 ? ["transfers still in transit"] : []),
  ];
}
