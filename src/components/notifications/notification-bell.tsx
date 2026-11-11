"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { callOrderApi } from "@/components/orders/order-api";
import { useRealtime } from "@/components/realtime/realtime-provider";

// The signed-in user's own in-app notifications (README section 22), such as food or drinks
// ready for their table. The server returns only the caller's notifications.

type Notice = {
  id: string;
  type: string;
  title: string;
  body: string;
  orderId: string | null;
  createdAt: string;
  readAt: string | null;
};

type Listing = { unreadCount: number; notifications: Notice[] };

async function fetchListing(): Promise<Listing | null> {
  const result = await callOrderApi<Listing>("GET", "/api/notifications");

  return result.ok ? result.data : null;
}

export function NotificationBell() {
  const { subscribe } = useRealtime();
  const [listing, setListing] = useState<Listing>({ unreadCount: 0, notifications: [] });
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // Escape or a click outside closes the panel.
  useEffect(() => {
    if (!open) {
      return;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      // Not awaited: the bell fills in when the list arrives.
      void fetchListing().then((data) => {
        if (data && !cancelled) {
          setListing(data);
        }
      });
    };

    refresh();

    const unsubscribe = subscribe((type) => {
      if (type === "notification.created" || type === "ready") {
        refresh();
      }
    });
    const fallback = setInterval(refresh, 60_000);

    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(fallback);
    };
  }, [subscribe]);

  async function markAllRead() {
    await callOrderApi("POST", "/api/notifications/read", { all: true });

    const data = await fetchListing();

    if (data) {
      setListing(data);
    }
  }

  return (
    <div ref={container} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-label={`Alerts, ${listing.unreadCount} unread`}
        data-testid="notification-bell"
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 items-center gap-2 rounded-md border border-neutral-300 bg-white px-3 text-sm font-medium shadow-sm hover:bg-neutral-50"
      >
        <Bell aria-hidden className="size-4" />
        Alerts
        {listing.unreadCount > 0 && (
          <span
            data-testid="notification-count"
            className="rounded-full bg-danger-700 px-2 text-xs font-bold text-white"
          >
            {listing.unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-neutral-200 bg-surface p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <p className="font-semibold">Notifications</p>
            {listing.unreadCount > 0 && (
              <button type="button" onClick={markAllRead} className="min-h-11 px-2 text-sm underline">
                Mark all read
              </button>
            )}
          </div>
          {listing.notifications.length === 0 ? (
            <p className="text-sm text-neutral-600">Nothing yet.</p>
          ) : (
            <ul className="max-h-96 space-y-2 overflow-y-auto">
              {listing.notifications.map((notice) => (
                <li
                  key={notice.id}
                  className={`rounded-md border p-2 text-sm ${notice.readAt ? "border-neutral-200" : "border-brand-500 bg-brand-50"}`}
                >
                  <p className="font-semibold">{notice.title}</p>
                  <p>{notice.body}</p>
                  <p className="text-xs text-neutral-600">
                    {new Date(notice.createdAt).toLocaleTimeString()}
                    {notice.orderId && (
                      <>
                        {" · "}
                        <Link href={`/orders/${notice.orderId}`} className="underline">
                          Open order
                        </Link>
                      </>
                    )}
                    {notice.type === "INVENTORY_LOW" && (
                      <>
                        {" · "}
                        <Link href="/inventory/low-stock" className="underline">
                          See low stock
                        </Link>
                      </>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
