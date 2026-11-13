"use client";

import { useEffect, useState } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { callOrderApi } from "@/components/orders/order-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { INPUT_STYLE } from "@/components/ui/field";
import type { GuestProfileSummary } from "@/modules/reservations/services/guest-profile-service";
import { apiFetch } from "@/components/forms/page-location";

// Phase 21 (policy 2): find a guest profile by name (or phone or email, with the contact
// permission), or create one. Nothing links until the host picks; matching never links itself.

export type PickedGuest = Pick<GuestProfileSummary, "id" | "profileNumber" | "displayName" | "vip">;

export function GuestPicker({
  onPick,
  suggestedName = "",
  canCreate,
}: {
  onPick: (guest: PickedGuest) => void;
  suggestedName?: string;
  canCreate: boolean;
}) {
  const [query, setQuery] = useState(suggestedName);
  const [results, setResults] = useState<GuestProfileSummary[]>([]);
  const [error, setError] = useState<{ code: string; message: string; requestId?: string } | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const text = query.trim();

    if (text.length < 2) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await apiFetch(`/api/guests?q=${encodeURIComponent(text)}`, { signal: controller.signal });

        if (response.ok) {
          setResults((await response.json()) as GuestProfileSummary[]);
        }
      } catch {
        // A cancelled or failed lookup leaves the last results; the host can keep typing.
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  // Fewer than two letters shows nothing, whatever the last lookup returned.
  const shown = query.trim().length >= 2 ? results : [];

  async function create() {
    setCreating(true);
    setError(null);

    const result = await callOrderApi<{ id: string; profileNumber: number }>("POST", "/api/guests", {
      displayName: query.trim(),
      allergies: [],
    });

    setCreating(false);

    if (result.ok) {
      onPick({ id: result.data.id, profileNumber: result.data.profileNumber, displayName: query.trim(), vip: false });
    } else {
      setError({ code: result.code, message: result.message, requestId: result.requestId });
    }
  }

  return (
    <div className="grid gap-2" role="group" aria-label="Guest profile">
      <label className="grid gap-1 text-sm font-medium">
        Find a guest profile
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name, phone or email"
          className={INPUT_STYLE}
        />
      </label>
      {shown.length > 0 && (
        <ul className="grid gap-1" aria-label="Matching guests">
          {shown.map((guest) => (
            <li key={guest.id}>
              <button
                type="button"
                onClick={() => onPick(guest)}
                className="flex w-full flex-wrap items-center gap-2 rounded border border-neutral-300 px-3 py-2 text-left text-sm hover:bg-neutral-50"
              >
                <span className="font-medium">{guest.displayName}</span>
                <span className="text-neutral-500">#{guest.profileNumber}</span>
                {guest.vip && <Badge tone="brand">VIP</Badge>}
                {guest.allergies.map((allergy) => (
                  <Badge key={allergy.allergenId} tone={allergy.severity === "SEVERE" ? "danger" : "warning"}>
                    {allergy.name}
                  </Badge>
                ))}
                {guest.phone && <span className="text-neutral-600">{guest.phone}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {canCreate && query.trim().length > 0 && (
        <Button type="button" onClick={create} pending={creating} pendingLabel="Creating…" className="justify-self-start">
          New profile for &quot;{query.trim()}&quot;
        </Button>
      )}
      {error && <ApiErrorMessage error={error} />}
    </div>
  );
}
