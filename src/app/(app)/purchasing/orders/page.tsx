import Link from "next/link";

import { EntityForm } from "@/components/forms/entity-form";
import { formatCost, PO_STATUS_LABELS } from "@/components/inventory/format";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/inventory/services/access";
import { listPurchaseOrders } from "@/modules/inventory/services/purchase-order-service";
import { listSuppliers } from "@/modules/inventory/services/supplier-service";

export default async function PurchaseOrdersPage() {
  const { location, actor } = await requirePageActor("purchasing.view");
  const database = getDatabase();
  const [orders, suppliers] = await Promise.all([
    listPurchaseOrders(database, actor),
    listSuppliers(database, actor),
  ]);

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Purchase orders</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>
      <p className="mb-6 text-sm text-neutral-600">
        An order is a request. Stock changes only when goods are received.
      </p>

      {actorHolds(actor, "purchasing.manage") && (
        <section aria-label="New purchase order" className="mb-8 rounded border border-neutral-200 p-4">
          <h2 className="mb-3 font-semibold">New purchase order</h2>
          <EntityForm
            method="POST"
            url="/api/purchasing/orders"
            submitLabel="Create draft order"
            resetOnSuccess
            fields={[
              {
                name: "supplierId",
                label: "Supplier",
                type: "select",
                required: true,
                options: [
                  { value: "", label: "Choose a supplier" },
                  ...suppliers.filter((supplier) => supplier.active).map((supplier) => ({ value: supplier.id, label: supplier.name })),
                ],
              },
              { name: "expectedAt", label: "Expected delivery (your local time)", type: "datetime-local" },
              { name: "notes", label: "Notes" },
            ]}
          />
        </section>
      )}

      {orders.length === 0 ? (
        <p className="text-neutral-600">No purchase orders yet.</p>
      ) : (
        <ul className="grid gap-2">
          {orders.map((order) => (
            <li
              key={order.id}
              aria-label={`Purchase order ${order.poNumber}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-neutral-200 p-3"
            >
              <span>
                <span className="font-medium">{order.poNumber}</span>{" "}
                <span className="text-neutral-600">
                  {order.supplierName} · {PO_STATUS_LABELS[order.status] ?? order.status} · {formatCost(order.total)}
                </span>
              </span>
              <Link
                href={`/purchasing/orders/${order.id}`}
                className="inline-flex min-h-11 items-center rounded border border-neutral-400 px-3 text-sm font-medium"
              >
                Open {order.poNumber}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
