import Link from "next/link";
import { z } from "zod";

import { NewOrderButton } from "@/components/orders/new-order-button";
import { formatMoney, ORDER_TYPE_LABELS } from "@/components/orders/order-api";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listOrders, type OrderSummary } from "@/modules/orders/queries/order-queries";
import { actorHolds } from "@/modules/orders/services/access";
import { StatusBadge } from "@/components/format/status-badge";

const searchSchema = z.object({
  session: z.uuid().optional(),
  type: z.enum(["DINE_IN", "BAR"]).optional(),
});

function OrderList({ orders, empty }: { orders: OrderSummary[]; empty: string }) {
  if (orders.length === 0) {
    return <p className="text-neutral-600">{empty}</p>;
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {orders.map((order) => (
        <li key={order.id}>
          <Link
            href={`/orders/${order.id}`}
            aria-label={`Order ${order.orderNumber}`}
            className="block rounded-md border border-neutral-300 p-4 hover:border-neutral-900"
          >
            <p className="flex justify-between font-semibold">
              <span>#{order.orderNumber}</span>
              <span>{order.status === "OPEN" ? formatMoney(order.totalDue) : <StatusBadge domain="order" status={order.status} />}</span>
            </p>
            <p className="text-sm">
              {ORDER_TYPE_LABELS[order.orderType]}
              {order.tableNumbers.length > 0 ? ` · Table ${order.tableNumbers.join(" + ")}` : ""}
              {order.customerName ? ` · ${order.customerName}` : ""}
            </p>
            <p className="text-sm text-neutral-600">
              {order.sentCount} sent · {order.draftCount} unsent
              {order.serverName ? ` · ${order.serverName}` : ""}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { actor } = await requirePageActor("orders.view");
  const search = searchSchema.safeParse(await searchParams);
  const filter = search.success ? search.data : {};
  const database = getDatabase();
  const canCreate = actorHolds(actor, "orders.create");

  if (filter.session) {
    const orders = await listOrders(database, actor, { tableSessionId: filter.session });
    const orderType = filter.type ?? "DINE_IN";

    return (
      <>
        <p className="mb-2">
          <Link href="/restaurant/floor" className="text-sm underline">
            Back to the floor
          </Link>
        </p>
        <h1 className="mb-4 text-2xl font-semibold">Orders for this table</h1>
        {canCreate && (
          <div className="mb-6">
            <NewOrderButton
              orderType={orderType}
              tableSessionId={filter.session}
              label={orderType === "BAR" ? "New bar order" : "New dine-in order"}
            />
          </div>
        )}
        <OrderList orders={orders} empty="No orders for this table yet." />
      </>
    );
  }

  const open = await listOrders(database, actor, { status: "OPEN" });
  const seated = open.filter((order) => order.orderType !== "TAKEOUT");
  const takeout = open.filter((order) => order.orderType === "TAKEOUT");

  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Orders</h1>
      <section aria-label="Takeout" className="mb-8">
        <h2 className="mb-3 text-xl font-semibold">Takeout</h2>
        {canCreate && (
          <div className="mb-4">
            <NewOrderButton orderType="TAKEOUT" label="New takeout order" />
          </div>
        )}
        <OrderList orders={takeout} empty="No open takeout orders." />
      </section>
      <section aria-label="Open table orders">
        <h2 className="mb-3 text-xl font-semibold">Tables and bar</h2>
        <p className="mb-3 text-sm text-neutral-600">Open a table&apos;s orders from the floor.</p>
        <OrderList orders={seated} empty="No open table orders." />
      </section>
    </>
  );
}
