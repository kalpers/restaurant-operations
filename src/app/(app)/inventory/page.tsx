import { InventoryTabs } from "@/components/inventory/inventory-tabs";
import { formatCost, formatQuantity } from "@/components/inventory/format";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listOnHand } from "@/modules/inventory/queries/stock-queries";
import { canSeeCost } from "@/modules/inventory/services/access";

/** Stock on hand here, from the balance projection the ledger maintains. Read-only. */
export default async function InventoryPage() {
  const { location, actor } = await requirePageActor("inventory.view");
  const rows = await listOnHand(getDatabase(), actor);
  const showCost = canSeeCost(actor);

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Inventory</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>
      <InventoryTabs current="/inventory" permissions={location.permissions} />

      {rows.length === 0 ? (
        <p className="text-neutral-600">No items are stocked here yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-neutral-300">
                <th className="py-2 pr-3">Item</th>
                <th className="py-2 pr-3">On hand</th>
                <th className="py-2 pr-3">Reorder at</th>
                <th className="py-2 pr-3">Par</th>
                {showCost && <th className="py-2 pr-3">Average cost</th>}
                {showCost && <th className="py-2">Value</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.inventoryItemId}
                  aria-label={`Stock ${row.name}`}
                  className="border-b border-neutral-100"
                >
                  <td className="py-2 pr-3">
                    {row.name}
                    {row.low && <span className="ml-2 text-amber-800">Low</span>}
                    {!row.stockedActive && <span className="ml-2 text-neutral-500">Not stocked</span>}
                  </td>
                  <td className="py-2 pr-3">
                    {formatQuantity(row.quantityOnHand)} {row.baseUnitCode}
                  </td>
                  <td className="py-2 pr-3">{formatQuantity(row.reorderLevel)}</td>
                  <td className="py-2 pr-3">{formatQuantity(row.parLevel)}</td>
                  {showCost && <td className="py-2 pr-3">{formatCost(row.weightedAverageCost)}</td>}
                  {showCost && <td className="py-2">{formatCost(row.stockValue)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
