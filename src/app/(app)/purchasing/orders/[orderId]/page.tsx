import { notFound } from "next/navigation";
import { z } from "zod";

import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { formatCost, formatQuantity } from "@/components/inventory/format";
import { ReceiveForm } from "@/components/inventory/receive-form";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/inventory/services/access";
import { getPurchaseOrder } from "@/modules/inventory/services/purchase-order-service";
import { listSupplierItems } from "@/modules/inventory/services/supplier-service";
import { compareDecimals } from "@/shared/decimal/decimal";
import { NotFoundError } from "@/shared/errors/app-error";
import { Breadcrumbs } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/format/status-badge";

export default async function PurchaseOrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { actor } = await requirePageActor("purchasing.view");
  const parsed = z.uuid().safeParse((await params).orderId);

  if (!parsed.success) {
    notFound();
  }

  const database = getDatabase();
  const detail = await getPurchaseOrder(database, actor, parsed.data).catch((error) => {
    if (error instanceof NotFoundError) {
      notFound();
    }

    throw error;
  });
  const { order, lines, receipts } = detail;
  const draft = order.status === "DRAFT";
  const canManage = draft && actorHolds(actor, "purchasing.manage");
  const receivable = order.status === "SUBMITTED" || order.status === "PARTIALLY_RECEIVED";
  const supplierItems = canManage
    ? (await listSupplierItems(database, actor, { supplierId: order.supplierId })).filter((entry) => entry.active)
    : [];

  return (
    <>
      <Breadcrumbs items={[{ label: "Purchase orders", href: "/purchasing/orders" }, { label: order.poNumber }]} />
      <h1 className="mb-1 text-2xl font-semibold">{order.poNumber}</h1>
      <p className="mb-6 text-neutral-600" aria-label="Order status">
        {order.supplierName} · <StatusBadge domain="purchaseOrder" status={order.status} /> · total {formatCost(detail.total)}
      </p>

      <section aria-label="Order lines" className="mb-8">
        <h2 className="mb-3 text-xl font-semibold">Lines</h2>
        {lines.length === 0 && <p className="mb-3 text-neutral-600">No lines yet.</p>}
        <ul className="grid gap-3">
          {lines.map((line) => (
            <li key={line.id} aria-label={`Order line ${line.itemName}`} className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
              <p className="font-medium">{line.itemName}</p>
              <p className="text-sm">
                Ordered {formatQuantity(line.orderedQuantity)} {line.unitCode} at {formatCost(line.unitPrice)} ={" "}
                {formatCost(line.lineTotal)} · received {formatQuantity(line.receivedQuantity)} · remaining{" "}
                {formatQuantity(line.remainingQuantity)}
              </p>
              {canManage && (
                <div className="mt-3 grid gap-3">
                  <EntityForm
                    method="PATCH"
                    url={`/api/purchasing/orders/${order.id}/lines/${line.id}`}
                    submitLabel={`Save ${line.itemName}`}
                    hidden={{ expectedVersion: order.version }}
                    fields={[
                      { name: "orderedQuantity", label: `Quantity (${line.unitCode})`, required: true, defaultValue: formatQuantity(line.orderedQuantity) },
                      { name: "unitPrice", label: `Price per ${line.unitCode}`, required: true, defaultValue: line.unitPrice },
                    ]}
                  />
                  <ActionButton
                    method="DELETE"
                    url={`/api/purchasing/orders/${order.id}/lines/${line.id}`}
                    body={{ expectedVersion: order.version }}
                    label={`Remove ${line.itemName}`}
                    confirm={{ title: `Remove ${line.itemName} from this order?`, confirmLabel: "Remove line" }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {canManage && supplierItems.length > 0 && (
        <section aria-label="Add a line" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
          <h2 className="mb-3 font-semibold">Add a line</h2>
          <EntityForm
            method="POST"
            url={`/api/purchasing/orders/${order.id}/lines`}
            submitLabel="Add line"
            resetOnSuccess
            hidden={{ expectedVersion: order.version }}
            fields={[
              {
                name: "supplierItemId",
                label: "Item",
                type: "select",
                required: true,
                options: supplierItems.map((entry) => ({ value: entry.id, label: `${entry.inventoryItemName} by the ${entry.purchaseUnitCode}` })),
              },
              { name: "orderedQuantity", label: "Quantity", required: true },
              { name: "unitPrice", label: "Price per unit (blank uses the listed cost)" },
            ]}
          />
        </section>
      )}

      <div className="mb-8 flex flex-wrap gap-3">
        {draft && actorHolds(actor, "purchasing.submit") && (
          <ActionButton method="POST" url={`/api/purchasing/orders/${order.id}/submit`} body={{ expectedVersion: order.version }} label="Submit order" />
        )}
        {(draft || receivable) && actorHolds(actor, "purchasing.submit") && (
          <ActionButton method="POST" url={`/api/purchasing/orders/${order.id}/cancel`} body={{ expectedVersion: order.version, reason: null }} label="Cancel order" confirm={{ title: "Cancel this purchase order?", body: "Nothing more can be received against it.", cancelLabel: "Keep order", confirmLabel: "Cancel order" }} />
        )}
      </div>

      {receivable && actorHolds(actor, "inventory.receive") && (
        <section aria-label="Receive" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
          <h2 className="mb-3 text-xl font-semibold">Receive a shipment</h2>
          <ReceiveForm
            orderId={order.id}
            lines={lines
              .filter((line) => compareDecimals(line.remainingQuantity, "0") > 0)
              .map((line) => ({
                id: line.id,
                itemName: line.itemName,
                lotTracked: line.lotTracked,
                unitCode: line.unitCode,
                remainingQuantity: formatQuantity(line.remainingQuantity),
                unitPrice: formatCost(line.unitPrice),
              }))}
          />
        </section>
      )}

      {receipts.length > 0 && (
        <section aria-label="Receipts" className="mb-8">
          <h2 className="mb-3 text-xl font-semibold">Receipts</h2>
          <ul className="grid gap-2 text-sm">
            {receipts.map((receipt) => (
              <li key={receipt.id} className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-3">
                {receipt.businessDate}
                {receipt.supplierReference ? ` · ${receipt.supplierReference}` : ""}
                <ul className="ml-4 list-disc">
                  {receipt.lines.map((receiptLine) => {
                    const line = lines.find((entry) => entry.id === receiptLine.purchaseOrderLineId);

                    return (
                      <li key={receiptLine.id}>
                        {line?.itemName}: {formatQuantity(receiptLine.receivedQuantity)} {line?.unitCode} at actual{" "}
                        {formatCost(receiptLine.actualUnitCost)} (ordered at {formatCost(line?.unitPrice ?? null)})
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
