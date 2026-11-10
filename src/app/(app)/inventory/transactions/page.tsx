import { InventoryTabs } from "@/components/inventory/inventory-tabs";
import { formatCost, formatQuantity, TRANSACTION_LABELS } from "@/components/inventory/format";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listTransactions } from "@/modules/inventory/queries/stock-queries";
import { canSeeCost } from "@/modules/inventory/services/access";
import { listItems } from "@/modules/inventory/services/item-service";
import { transactionFilterSchema } from "@/modules/inventory/validators/inventory-validators";
import { INPUT_BASE } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty-state";

const INPUT_CLASS = INPUT_BASE;

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
        <button type="submit" className="min-h-11 rounded-md border border-neutral-300 px-4 font-medium">
          Filter
        </button>
      </form>

      {rows.length === 0 ? (
        <EmptyState title="No transactions match." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-surface shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-neutral-100 text-neutral-800">
              <tr className="border-b border-neutral-300">
                <th className="px-3 py-2">Business date</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Entered</th>
                <th className="px-3 py-2">Change (stock unit)</th>
                <th className="px-3 py-2">After</th>
                <th className="px-3 py-2">Reason</th>
                {showCost && <th className="py-2">Cost</th>}
              </tr>
            </thead>
            <tbody className="[&>tr:nth-child(even)]:bg-neutral-50">
              {rows.map((row) => (
                <tr
                  key={row.id}
                  aria-label={`Transaction ${TRANSACTION_LABELS[row.transactionType]} ${row.itemName}`}
                  className="border-b border-neutral-100"
                >
                  <td className="px-3 py-2">{row.businessDate}</td>
                  <td className="px-3 py-2">{row.itemName}</td>
                  <td className="px-3 py-2">{TRANSACTION_LABELS[row.transactionType] ?? row.transactionType}</td>
                  <td className="px-3 py-2">
                    {formatQuantity(row.quantity)} {row.unitCode}
                  </td>
                  <td className="px-3 py-2">{formatQuantity(row.baseQuantityDelta)}</td>
                  <td className="px-3 py-2">{formatQuantity(row.quantityAfter)}</td>
                  <td className="px-3 py-2">{row.reasonCode ?? ""}</td>
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
