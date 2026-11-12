"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

// One Server-Sent Events connection per tab to /api/realtime/stream. Events are committed
// outbox events and mean "something changed": screens refetch through their normal,
// authorized queries. If the stream drops, the browser reconnects on its own, the badge
// says so, and screens still refresh on a slow timer, so nothing depends on the stream.

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

type Listener = (type: string, data: unknown) => void;

type RealtimeContextValue = {
  status: ConnectionStatus;
  subscribe: (listener: Listener) => () => void;
};

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

const EVENT_TYPES = [
  "ready",
  "order.items-submitted",
  "kitchen.ticket-created",
  "kitchen.item-status-changed",
  "kitchen.item-ready",
  "kitchen.ticket-ready",
  "kitchen.remake-requested",
  "notification.created",
  // Phase 17: held courses, split checks, settlement changes, refunds and cash drawers.
  "kitchen.course-fired",
  "order.items-moved",
  "order.closed",
  "settlement.opened",
  "settlement.tender-recorded",
  "settlement.tender-voided",
  "settlement.completed",
  "settlement.cancelled",
  "settlement.refund-recorded",
  "settlement.refund-voided",
  "drawer.session-opened",
  "drawer.session-closed",
  "drawer.movement-recorded",
  // Phase 19: an item 86'd, restored or set to sell anyway.
  "menu.availability-changed",
  // Phase 21: a party's or check's allergies changed.
  "guest.allergies-changed",
  // Phase 22: a guest booked or cancelled on the public page.
  "reservation.online-booked",
  "reservation.guest-cancelled",
];

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      return;
    }

    const source = new EventSource("/api/realtime/stream");
    const handle = (event: MessageEvent<string>) => {
      let data: unknown = null;

      try {
        data = JSON.parse(event.data);
      } catch {
        // A malformed message is ignored; the next one or the fallback refresh catches up.
      }

      if (event.type === "ready") {
        setStatus("live");
      }

      for (const listener of listeners.current) {
        listener(event.type, data);
      }
    };

    for (const type of EVENT_TYPES) {
      source.addEventListener(type, handle as EventListener);
    }

    source.onerror = () => setStatus("reconnecting");

    return () => source.close();
  }, []);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);

    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const value = useMemo<RealtimeContextValue>(() => ({ status, subscribe }), [status, subscribe]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

const DETACHED: RealtimeContextValue = { status: "connecting", subscribe: () => () => {} };

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext) ?? DETACHED;
}

/**
 * Refreshes the current server-rendered page when a matching event arrives (debounced),
 * when the stream (re)connects, and every `fallbackMs` regardless.
 */
export function useRealtimeRefresh(eventTypes: readonly string[], fallbackMs = 30_000): ConnectionStatus {
  const router = useRouter();
  const { status, subscribe } = useRealtime();
  const types = eventTypes.join(",");

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wanted = new Set(types.split(","));
    const refresh = () => {
      if (timer) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => router.refresh(), 250);
    };
    const unsubscribe = subscribe((type) => {
      if (type === "ready" || wanted.has(type)) {
        refresh();
      }
    });
    const fallback = setInterval(() => router.refresh(), fallbackMs);

    return () => {
      unsubscribe();
      clearInterval(fallback);

      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [router, subscribe, types, fallbackMs]);

  return status;
}

/**
 * The tab's one connection status, shown once in the app shell header. It reads the
 * provider's existing stream and never opens a connection of its own.
 */
export function ConnectionBadge() {
  const { status } = useRealtime();
  const label = status === "live" ? "Live" : status === "connecting" ? "Connecting…" : "Reconnecting…";
  const tone =
    status === "live"
      ? "border-success-300 bg-success-50 text-success-800"
      : "border-warning-300 bg-warning-50 text-warning-900";
  const dot = status === "live" ? "bg-success-500" : "animate-pulse bg-warning-500";

  return (
    <span
      role="status"
      aria-live="polite"
      title="Connection to live updates"
      className={`inline-flex min-h-8 items-center gap-2 rounded-full border px-3 text-xs font-semibold ${tone}`}
    >
      <span aria-hidden className={`size-2 rounded-full ${dot}`} />
      <span data-testid="connection-status">{label}</span>
    </span>
  );
}
