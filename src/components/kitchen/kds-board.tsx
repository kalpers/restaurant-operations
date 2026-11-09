"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { callOrderApi, ORDER_TYPE_LABELS } from "@/components/orders/order-api";
import { ConnectionBadge, useRealtimeRefresh } from "@/components/realtime/realtime-provider";
import type { QueueItem, QueueTicket } from "@/modules/kitchen/queries/kitchen-queries";

// A Kitchen or Bar display. It shows what the server returns and sends one explicit action
// per button: Start (NEW -> PREPARING), Ready (PREPARING -> READY) and Bump (READY ->
// COMPLETED). Buttons appear only for what the server says this user may do, but the API
// checks every request itself.

const QUEUE_EVENTS = [
  "kitchen.ticket-created",
  "kitchen.item-status-changed",
  "kitchen.item-ready",
  "kitchen.ticket-ready",
];

const STATUS_STYLE: Record<string, string> = {
  NEW: "bg-sky-100 text-sky-900",
  PREPARING: "bg-amber-100 text-amber-900",
  READY: "bg-green-100 text-green-900",
  COMPLETED: "bg-neutral-200 text-neutral-800",
  CANCELLED: "bg-red-100 text-red-900 line-through",
};

const AGE_STYLE: Record<string, string> = {
  normal: "border-neutral-300",
  warning: "border-amber-500 border-2",
  late: "border-red-600 border-4",
};

const ACTION_LABEL = { start: "Start", ready: "Ready", complete: "Bump" } as const;

export type KdsFilters = { stationId?: string; status?: string; orderType?: string };

type Props = {
  title: string;
  path: string;
  active: QueueTicket[];
  recentlyCompleted: QueueTicket[];
  serverTime: string;
  stations: { id: string; code: string; name: string }[];
  filters: KdsFilters;
};

function elapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);

  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Seconds since submission: the server's age at render plus a local tick. Cards remount on
 * every refresh (keyed by server time), so the count never drifts far from the server.
 */
function useAge(serverAgeSeconds: number) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);

    return () => clearInterval(timer);
  }, []);

  return serverAgeSeconds + tick;
}

function ItemRow({ item }: { item: QueueItem }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = item.actions.start ? "start" : item.actions.ready ? "ready" : item.actions.complete ? "complete" : null;

  async function act(name: "start" | "ready" | "complete") {
    setPending(true);
    setError(null);

    const result = await callOrderApi("POST", `/api/kitchen/items/${item.id}/${name}`, {
      expectedVersion: item.version,
    });

    setPending(false);

    if (!result.ok) {
      if (result.status === 401) {
        router.push("/login");

        return;
      }

      setError(result.message);
    }

    router.refresh();
  }

  return (
    <li className="flex flex-col gap-2 border-t border-neutral-200 py-2 first:border-t-0" data-testid="ticket-item">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-lg font-semibold">
            {item.quantity}× {item.name}
            {item.attemptNumber > 1 && (
              <span className="ml-2 rounded bg-purple-100 px-2 text-xs font-bold text-purple-900">
                Remake {item.attemptNumber - 1}
              </span>
            )}
          </p>
          {item.modifiers.length > 0 && (
            <ul className="text-sm">
              {item.modifiers.map((modifier, index) => (
                <li key={`${modifier.code}-${index}`}>• {modifier.name}</li>
              ))}
            </ul>
          )}
          {item.instructions && <p className="text-sm font-medium italic">{item.instructions}</p>}
          {item.cancelReason && <p className="text-xs text-red-800">{item.cancelReason}</p>}
        </div>
        <span
          data-testid="item-status"
          className={`shrink-0 rounded px-2 py-1 text-xs font-bold ${STATUS_STYLE[item.status] ?? ""}`}
        >
          {item.status}
        </span>
      </div>
      {action && (
        <button
          type="button"
          disabled={pending}
          onClick={() => act(action)}
          className="min-h-12 rounded bg-neutral-900 px-4 text-base font-semibold text-white disabled:opacity-50"
        >
          {ACTION_LABEL[action]}
        </button>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </li>
  );
}

function TicketCard({ ticket }: { ticket: QueueTicket }) {
  const age = useAge(ticket.ageSeconds);

  return (
    <article
      data-testid="ticket-card"
      data-order-number={ticket.orderNumber}
      aria-label={`Order ${ticket.orderNumber} at ${ticket.stationName}`}
      className={`flex flex-col rounded-lg bg-white p-3 shadow-sm ${AGE_STYLE[ticket.ageBand] ?? ""}`}
    >
      <header className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="text-xl font-bold">#{ticket.orderNumber}</p>
          <p className="text-sm">
            {ORDER_TYPE_LABELS[ticket.orderType] ?? ticket.orderType}
            {ticket.tableLabel && ` · ${ticket.tableLabel}`}
            {ticket.pickupLabel && ` · ${ticket.pickupLabel}`}
          </p>
          <p className="text-xs text-neutral-600">
            {ticket.stationName} · Round {ticket.batchNumber}
            {ticket.serverName && ` · ${ticket.serverName}`}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-lg font-semibold" aria-label="Elapsed">
            {elapsed(age)}
          </p>
          <span
            data-testid="ticket-status"
            className={`rounded px-2 py-1 text-xs font-bold ${STATUS_STYLE[ticket.status] ?? ""}`}
          >
            {ticket.status}
          </span>
        </div>
      </header>
      <ul>
        {ticket.items.map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </ul>
    </article>
  );
}

export function KdsBoard({ title, path, active, recentlyCompleted, serverTime, stations, filters }: Props) {
  const status = useRealtimeRefresh(QUEUE_EVENTS);
  const router = useRouter();

  function applyFilter(name: keyof KdsFilters, value: string) {
    const next = new URLSearchParams();
    const merged = { ...filters, [name]: value || undefined };

    for (const [key, entry] of Object.entries(merged)) {
      if (entry) {
        next.set(key, entry);
      }
    }

    router.push(next.size > 0 ? `${path}?${next.toString()}` : path);
  }

  const select = "min-h-11 rounded border border-neutral-400 bg-white px-2 text-sm";

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <ConnectionBadge status={status} />
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filters">
        <label className="flex items-center gap-2 text-sm">
          Station
          <select className={select} value={filters.stationId ?? ""} onChange={(event) => applyFilter("stationId", event.target.value)}>
            <option value="">All</option>
            {stations.map((station) => (
              <option key={station.id} value={station.id}>
                {station.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          Status
          <select className={select} value={filters.status ?? ""} onChange={(event) => applyFilter("status", event.target.value)}>
            <option value="">Active</option>
            <option value="NEW">New</option>
            <option value="PREPARING">Preparing</option>
            <option value="READY">Ready</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          Order type
          <select className={select} value={filters.orderType ?? ""} onChange={(event) => applyFilter("orderType", event.target.value)}>
            <option value="">All</option>
            <option value="DINE_IN">Dine-in</option>
            <option value="BAR">Bar</option>
            <option value="TAKEOUT">Takeout</option>
          </select>
        </label>
      </div>
      {active.length === 0 ? (
        <p className="rounded border border-dashed border-neutral-400 p-6 text-center text-neutral-600">
          Nothing to prepare.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="active-queue">
          {active.map((ticket) => (
            <TicketCard key={`${ticket.id}-${serverTime}`} ticket={ticket} />
          ))}
        </div>
      )}
      {recentlyCompleted.length > 0 && (
        <details className="rounded border border-neutral-300 p-3" data-testid="recently-completed">
          <summary className="min-h-11 cursor-pointer font-medium">
            Recently completed ({recentlyCompleted.length})
          </summary>
          <ul className="mt-2 space-y-1 text-sm">
            {recentlyCompleted.map((ticket) => (
              <li key={ticket.id}>
                #{ticket.orderNumber} · {ticket.stationName} ·{" "}
                {ticket.items.map((item) => `${item.quantity}× ${item.name}`).join(", ")}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
