"use client";

import { ChefHat } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { StatusBadge } from "@/components/format/status-badge";
import { callOrderApi, ORDER_TYPE_LABELS } from "@/components/orders/order-api";
import { useRealtimeRefresh } from "@/components/realtime/realtime-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { EmptyState } from "@/components/ui/empty-state";
import type { QueueItem, QueueTicket } from "@/modules/kitchen/queries/kitchen-queries";

import { AGE_BORDER, AGE_HEADER, AGE_LABEL, elapsed, SoundToggle, useAge, useNewTicketSound } from "./ticket-age";

// A Kitchen or Bar display. It shows what the server returns and sends one explicit action
// per button: Start (NEW -> PREPARING), Ready (PREPARING -> READY) and Bump (READY ->
// COMPLETED). Buttons appear only for what the server says this user may do, but the API
// checks every request itself.

const QUEUE_EVENTS = [
  "kitchen.ticket-created",
  "kitchen.item-status-changed",
  "kitchen.item-ready",
  "kitchen.ticket-ready",
  // Phase 17: a fired course joins the queue.
  "kitchen.course-fired",
];

const ACTION_LABEL = { start: "Start", ready: "Ready", complete: "Bump" } as const;
const ACTION_VARIANT = { start: "primary", ready: "primary", complete: "secondary" } as const;

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

function ItemRow({ item }: { item: QueueItem }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; requestId?: string } | null>(null);
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

      setError(result);
    }

    router.refresh();
  }

  return (
    <li className="flex flex-col gap-2 border-t border-neutral-200 py-3 first:border-t-0" data-testid="ticket-item">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xl font-bold">
            {item.quantity}× {item.name}
            {item.attemptNumber > 1 && (
              <span className="ml-2 rounded bg-purple-100 px-2 align-middle text-xs font-bold text-purple-900">
                Remake {item.attemptNumber - 1}
              </span>
            )}
          </p>
          {item.allergyAlert && (
            <p
              role="alert"
              data-testid="ticket-allergy-alert"
              className="mt-1 rounded border-2 border-danger-600 bg-danger-50 px-2 py-1 text-base font-bold text-danger-800"
            >
              {item.allergyAlert}
            </p>
          )}
          {item.modifiers.length > 0 && (
            <ul className="text-base">
              {item.modifiers.map((modifier, index) => (
                <li key={`${modifier.code}-${index}`}>• {modifier.name}</li>
              ))}
            </ul>
          )}
          {item.instructions && (
            <p className="mt-1 rounded bg-warning-50 px-2 py-1 text-base font-semibold text-warning-900 italic">
              {item.instructions}
            </p>
          )}
          {item.cancelReason && <p className="text-sm text-danger-800">{item.cancelReason}</p>}
        </div>
        <StatusBadge
          domain="fulfillment"
          status={item.status}
          data-testid="item-status"
          className={cn("shrink-0 text-sm", item.status === "CANCELLED" && "line-through")}
        />
      </div>
      {action && (
        <Button
          variant={ACTION_VARIANT[action]}
          size="lg"
          pending={pending}
          onClick={() => act(action)}
          className="w-full"
        >
          {ACTION_LABEL[action]}
        </Button>
      )}
      <ApiErrorMessage error={error} />
    </li>
  );
}

function TicketCard({ ticket }: { ticket: QueueTicket }) {
  const age = useAge(ticket.ageSeconds);
  const ageLabel = AGE_LABEL[ticket.ageBand];

  return (
    <article
      data-testid="ticket-card"
      data-order-number={ticket.orderNumber}
      data-age-band={ticket.ageBand}
      aria-label={`Order ${ticket.orderNumber} at ${ticket.stationName}`}
      className={cn("flex flex-col overflow-hidden rounded-lg border-2 bg-white shadow-sm", AGE_BORDER[ticket.ageBand])}
    >
      <header className={cn("flex items-start justify-between gap-2 px-3 py-2", AGE_HEADER[ticket.ageBand])}>
        <div>
          <p className="text-2xl font-bold">#{ticket.orderNumber}</p>
          <p className="text-base font-medium">
            {ORDER_TYPE_LABELS[ticket.orderType] ?? ticket.orderType}
            {ticket.tableLabel && ` · ${ticket.tableLabel}`}
            {ticket.pickupLabel && ` · ${ticket.pickupLabel}`}
          </p>
          <p className="text-sm opacity-90">
            {ticket.stationName} · Round {ticket.batchNumber}
            {ticket.courseNumber > 1 && ` · Course ${ticket.courseNumber}`}
            {ticket.serverName && ` · ${ticket.serverName}`}
          </p>
        </div>
        <div className="grid justify-items-end gap-1 text-right">
          <p className="font-mono text-2xl font-bold" aria-label="Elapsed">
            {elapsed(age)}
          </p>
          {ageLabel && <p className="text-xs font-bold uppercase">{ageLabel}</p>}
          <StatusBadge domain="fulfillment" status={ticket.status} data-testid="ticket-status" className="text-sm" />
        </div>
      </header>
      <ul className="px-3">
        {ticket.items.map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </ul>
    </article>
  );
}

export function KdsBoard({ title, path, active, recentlyCompleted, serverTime, stations, filters }: Props) {
  useRealtimeRefresh(QUEUE_EVENTS);
  const router = useRouter();
  const sound = useNewTicketSound(active.map((ticket) => ticket.id));

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

  const select = "min-h-11 rounded-md border border-neutral-300 bg-white px-2 text-sm shadow-sm";

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-neutral-700">{active.length} open</span>
          <SoundToggle enabled={sound.enabled} onToggle={sound.toggle} />
        </div>
      </div>
      <div className="flex flex-wrap gap-3" role="group" aria-label="Filters">
        <label className="flex items-center gap-2 text-sm font-medium">
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
        <label className="flex items-center gap-2 text-sm font-medium">
          Status
          <select className={select} value={filters.status ?? ""} onChange={(event) => applyFilter("status", event.target.value)}>
            <option value="">Active</option>
            <option value="NEW">New</option>
            <option value="PREPARING">Preparing</option>
            <option value="READY">Ready</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm font-medium">
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
        <EmptyState icon={ChefHat} title="Nothing to prepare">
          New tickets appear here as soon as a server sends them.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" data-testid="active-queue">
          {active.map((ticket) => (
            <TicketCard key={`${ticket.id}-${serverTime}`} ticket={ticket} />
          ))}
        </div>
      )}
      {recentlyCompleted.length > 0 && (
        <details className="rounded-lg border border-neutral-200 bg-surface p-3" data-testid="recently-completed">
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
