"use client";

import { useRealtimeRefresh } from "@/components/realtime/realtime-provider";

// Phase 19 policy A9: the 86 board refetches after an 86, a restore or a SEND, and every 30 s.
const EVENTS = ["menu.availability-changed", "order.items-submitted"] as const;

export function StockBoardRefresh() {
  useRealtimeRefresh(EVENTS, 30_000);

  return null;
}
