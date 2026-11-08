import { InventoryTabs } from "@/components/inventory/inventory-tabs";
import { formatCost, formatQuantity, TRANSACTION_LABELS } from "@/components/inventory/format";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listTransactions } from "@/modules/inventory/queries/stock-queries";
import { canSeeCost } from "@/modules/inventory/services/access";
import { listItems } from "@/modules/inventory/services/item-service";
import { transactionFilterSchema } from "@/modules/inventory/validators/inventory-validators";

const INPUT_CLASS = "min-h-11 rounded border border-neutral-300 bg-white px-3 py-2 text-base";

/** The ledger: read-only, newest first. Nothing here can be edited or deleted. */
export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { location, actor } = await requirePageActor("inventory.view");
  const raw = Object.fromEntries(
    Object.entries(await searchParams).flatMap(([key, value]) =>
      typeof value === "string" && value !== "" ? [[key, value]] : [],
    ),
  );
  const parsed = transactionFilterSchema.safeParse(raw);
  const filter = parsed.success ? parsed.data : {};
  const database = getDatabase();
  const [rows, items] = await Promise.all([
    listTransactions(database, actor, filter),
    listItems(database, actor),
  ]);
  const showCost = canSeeCost(actor);

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Inventory transactions</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>
      <InventoryTabs current="/inventory/transactions" permissions={location.permissions} />

      <form method="get" aria-label="Filter transactions" className="mb-6 flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm font-medium">
          Item
          <select name="inventoryItemId" defaultValue={filter.inventoryItemId ?? ""} className={INPUT_CLASS}>
            <option value="">All items</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Type
          <select name="transactionType" defaultValue={filter.transactionType ?? ""} className={INPUT_CLASS}>
            <option value="">All types</option>
            {Object.entries(TRANSACTION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">
          From business date
          <input type="date" name="fromBusinessDate" defaultValue={filter.fromBusinessDate} className={INPUT_CLASS} />
        </label>
        <label className="grid gap-1 text-sm font-medium">
          To business date
          <input type="date" name="toBusinessDate" defaultValue={filter.toBusinessDate} className={INPUT_CLASS} />
        </label>
        <button type="submit" className="min-h-11 rounded border border-neutral-400 px-4 font-medium">
          Filter
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="text-neutral-600">No transactions match.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-neutral-300">
                <th className="py-2 pr-3">Business date</th>
                <th className="py-2 pr-3">Item</th>
                <th className="py-2 pr-3">Type</th>
                <th className="py-2 pr-3">Entered</th>
                <th className="py-2 pr-3">Change (stock unit)</th>
                <th className="py-2 pr-3">After</th>
                <th className="py-2 pr-3">Reason</th>
                {showCost && <th className="py-2">Cost</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  aria-label={`Transaction ${TRANSACTION_LABELS[row.transactionType]} ${row.itemName}`}
                  className="border-b border-neutral-100"
                >
                  <td className="py-2 pr-3">{row.businessDate}</td>
                  <td className="py-2 pr-3">{row.itemName}</td>
                  <td className="py-2 pr-3">{TRANSACTION_LABELS[row.transactionType] ?? row.transactionType}</td>
                  <td className="py-2 pr-3">
                    {formatQuantity(row.quantity)} {row.unitCode}
                  </td>
                  <td className="py-2 pr-3">{formatQuantity(row.baseQuantityDelta)}</td>
                  <td className="py-2 pr-3">{formatQuantity(row.quantityAfter)}</td>
                  <td className="py-2 pr-3">{row.reasonCode ?? ""}</td>
                  {showCost && <td className="py-2">{formatCost(row.totalCost)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
