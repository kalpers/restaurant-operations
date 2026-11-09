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

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const label = status === "live" ? "Live" : status === "connecting" ? "Connecting…" : "Reconnecting…";
  const tone =
    status === "live"
      ? "border-green-700 text-green-800"
      : "border-amber-600 text-amber-800";

  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="connection-status"
      className={`inline-flex min-h-8 items-center rounded-full border px-3 text-xs font-semibold ${tone}`}
    >
      {label}
    </span>
  );
}
