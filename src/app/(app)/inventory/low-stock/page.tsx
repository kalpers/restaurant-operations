import { InventoryTabs } from "@/components/inventory/inventory-tabs";
import { formatCost, formatQuantity } from "@/components/inventory/format";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listLowStock } from "@/modules/inventory/queries/stock-queries";
import { EmptyState } from "@/components/ui/empty-state";

/** A recommendation only. No order is created, and no supplier is chosen for you. */
export default async function LowStockPage() {
  const { location, actor } = await requirePageActor("inventory.view");
  const rows = await listLowStock(getDatabase(), actor);

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Low stock</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>
      <InventoryTabs current="/inventory/low-stock" permissions={location.permissions} />
      <p className="mb-4 text-sm text-neutral-600">
        Items at or below their reorder level. Suggested quantities bring stock up to the reorder
        target. To order, create a purchase order and choose a supplier.
      </p>

      {rows.length === 0 ? (
        <EmptyState title="Nothing is at or below its reorder level." />
      ) : (
        <ul className="grid gap-3">
          {rows.map((row) => (
            <li
              key={row.inventoryItemId}
              aria-label={`Low stock ${row.name}`}
              className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-4"
            >
              <p className="font-medium">{row.name}</p>
              <p className="text-sm">
                On hand {formatQuantity(row.quantityOnHand)} {row.baseUnitCode} · reorder at{" "}
                {formatQuantity(row.reorderLevel)} · suggest {formatQuantity(row.suggestedQuantity)}{" "}
                {row.baseUnitCode}
              </p>
              {row.supplierOptions.length === 0 ? (
                <p className="text-sm text-warning-800">No active supplier sells this item.</p>
              ) : (
                <ul className="ml-4 mt-2 list-disc text-sm">
                  {row.supplierOptions.map((option) => (
                    <li key={option.supplierItemId}>
                      {option.supplierName}: by the {option.purchaseUnitCode} ({formatQuantity(option.baseUnitsPerPurchase)}{" "}
                      {row.baseUnitCode})
                      {option.lastUnitCost !== null && `, last ${formatCost(option.lastUnitCost)}`}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
