"use client";

import { ClipboardCheck } from "lucide-react";

import { StatusBadge } from "@/components/format/status-badge";
import { ORDER_TYPE_LABELS } from "@/components/orders/order-api";
import { useRealtimeRefresh } from "@/components/realtime/realtime-provider";
import { cn } from "@/components/ui/cn";
import { EmptyState } from "@/components/ui/empty-state";
import { statusLabel } from "@/components/format/status-labels";
import type { ExpoOrder } from "@/modules/kitchen/queries/kitchen-queries";

import { AGE_BORDER, AGE_HEADER, AGE_LABEL, elapsed, useAge } from "./ticket-age";

// EXPO: read-only. It shows each order's items with their readiness across every station;
// it has no actions and is not a preparation step.

const EVENTS = ["kitchen.ticket-created", "kitchen.item-status-changed", "kitchen.item-ready", "kitchen.ticket-ready"];

function ExpoCard({ order }: { order: ExpoOrder }) {
  const age = useAge(order.ageSeconds);
  const ageLabel = AGE_LABEL[order.ageBand];

  return (
    <article
      data-testid="expo-order"
      data-order-number={order.orderNumber}
      data-age-band={order.ageBand}
      className={cn("overflow-hidden rounded-lg border-2 bg-white shadow-sm", AGE_BORDER[order.ageBand])}
    >
      <header className={cn("flex items-start justify-between gap-2 px-3 py-2", AGE_HEADER[order.ageBand])}>
        <div>
          <p className="text-2xl font-bold">#{order.orderNumber}</p>
          <p className="text-base font-medium">
            {ORDER_TYPE_LABELS[order.orderType] ?? order.orderType}
            {order.tableLabel && ` · ${order.tableLabel}`}
            {order.pickupLabel && ` · ${order.pickupLabel}`}
          </p>
        </div>
        <div className="grid justify-items-end gap-1 text-right">
          <p className="font-mono text-2xl font-bold" aria-label="Waiting">
            {elapsed(age)}
          </p>
          {ageLabel && <p className="text-xs font-bold uppercase">{ageLabel}</p>}
          <StatusBadge domain="fulfillment" status={order.status} className="text-sm" />
        </div>
      </header>
      <ul className="space-y-2 p-3">
        {order.items.map((item) => (
          <li key={item.orderItemId} className="flex items-start justify-between gap-2 text-base">
            <span>
              <span className="font-semibold">
                {item.quantity}× {item.name}
              </span>
              <span className="block text-xs text-neutral-700">
                {item.stations.map((station) => `${station.name}: ${statusLabel("fulfillment", station.status)}`).join(" · ")}
              </span>
            </span>
            <StatusBadge domain="fulfillment" status={item.status} className={cn(item.status === "CANCELLED" && "line-through")} />
          </li>
        ))}
      </ul>
    </article>
  );
}

export function ExpoBoard({ orders, serverTime }: { orders: ExpoOrder[]; serverTime: string }) {
  useRealtimeRefresh(EVENTS);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Expo</h1>
        <span className="text-sm font-medium text-neutral-700">{orders.length} open</span>
      </div>
      <p className="text-sm text-neutral-700">Read-only view of every station, oldest first. Times show how long each order has waited.</p>
      {orders.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="No open work">
          Orders appear here once something is sent to a station.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {orders.map((order) => (
            <ExpoCard key={`${order.orderId}-${serverTime}`} order={order} />
          ))}
        </div>
      )}
    </section>
  );
}
