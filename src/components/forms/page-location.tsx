"use client";

import { LOCATION_HEADER } from "@/shared/http/location-header";

// The location this tab's page was rendered for (Phase 23, policy 4). The app shell sets
// it on every render, and every API call from the tab sends it, so a write from a tab
// left at another location is refused instead of acting where the page doesn't show.
let pageLocationId: string | null = null;

/** Marks the page's location. Renders nothing. */
export function PageLocation({ locationId }: { locationId: string | null }) {
  pageLocationId = locationId;

  return null;
}

/** Headers with the page's location added. */
export function withPageLocation(headers?: HeadersInit): Headers {
  const result = new Headers(headers);

  if (pageLocationId) {
    result.set(LOCATION_HEADER, pageLocationId);
  }

  return result;
}

/** `fetch` for the app's own APIs: adds the page's location. */
export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, headers: withPageLocation(init.headers) });
}
