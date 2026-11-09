"use client";

import { ORDER_TYPE_LABELS } from "@/components/orders/order-api";
import { ConnectionBadge, useRealtimeRefresh } from "@/components/realtime/realtime-provider";
import type { ExpoOrder } from "@/modules/kitchen/queries/kitchen-queries";

// EXPO: read-only. It shows each order's items with their readiness across every station;
// it has no actions and is not a preparation step.

const EVENTS = ["kitchen.ticket-created", "kitchen.item-status-changed", "kitchen.item-ready", "kitchen.ticket-ready"];

const STATUS_STYLE: Record<string, string> = {
  NEW: "bg-sky-100 text-sky-900",
  PREPARING: "bg-amber-100 text-amber-900",
  READY: "bg-green-100 text-green-900",
  COMPLETED: "bg-neutral-200 text-neutral-800",
  CANCELLED: "bg-red-100 text-red-900 line-through",
};

export function ExpoBoard({ orders, serverTime }: { orders: ExpoOrder[]; serverTime: string }) {
  const status = useRealtimeRefresh(EVENTS);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Expo</h1>
        <ConnectionBadge status={status} />
      </div>
      <p className="text-sm text-neutral-600">Read-only view of every station. Updated {new Date(serverTime).toLocaleTimeString()}.</p>
      {orders.length === 0 ? (
        <p className="rounded border border-dashed border-neutral-400 p-6 text-center text-neutral-600">No open work.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {orders.map((order) => (
            <article
              key={order.orderId}
              data-testid="expo-order"
              data-order-number={order.orderNumber}
              className="rounded-lg border border-neutral-300 bg-white p-3"
            >
              <header className="mb-2 flex items-start justify-between">
                <div>
                  <p className="text-xl font-bold">#{order.orderNumber}</p>
                  <p className="text-sm">
                    {ORDER_TYPE_LABELS[order.orderType] ?? order.orderType}
                    {order.tableLabel && ` · ${order.tableLabel}`}
                    {order.pickupLabel && ` · ${order.pickupLabel}`}
                  </p>
                </div>
                <span className={`rounded px-2 py-1 text-xs font-bold ${STATUS_STYLE[order.status] ?? ""}`}>
                  {order.status}
                </span>
              </header>
              <ul className="space-y-1">
                {order.items.map((item) => (
                  <li key={item.orderItemId} className="flex items-start justify-between gap-2 text-sm">
                    <span>
                      {item.quantity}× {item.name}
                      <span className="block text-xs text-neutral-600">
                        {item.stations.map((station) => `${station.name}: ${station.status}`).join(" · ")}
                      </span>
                    </span>
                    <span className={`rounded px-2 text-xs font-bold ${STATUS_STYLE[item.status] ?? ""}`}>
                      {item.status}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
