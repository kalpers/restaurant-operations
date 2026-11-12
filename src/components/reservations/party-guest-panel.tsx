"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { callOrderApi } from "@/components/orders/order-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import type { PartyGuestView } from "@/modules/reservations/services/reservation-service";

import { GuestPicker } from "./guest-picker";

// Phase 21 (policies 2, 8, 17): a visit's guest profile and allergies at the host stand.

export type HostGuestAbilities = {
  /** `guests.view`: open profiles. */
  view: boolean;
  /** `guests.manage`: link profiles and record allergies. */
  manage: boolean;
};

export type AllergenOption = { id: string; name: string; active: boolean };

type Failure = { code: string; message: string; requestId?: string };

/** VIP and allergy marks for a card's header. Allergen names only, never notes. */
export function GuestMarks({ guest }: { guest: PartyGuestView }) {
  if (!guest.profile?.vip && guest.allergies.length === 0) {
    return null;
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {guest.profile?.vip && <Badge tone="brand">VIP</Badge>}
      {guest.allergies.length > 0 && (
        <Badge tone={guest.allergies.some((entry) => entry.severity === "SEVERE") ? "danger" : "warning"}>
          Allergy: {guest.allergies.map((entry) => entry.name).join(", ")}
        </Badge>
      )}
    </span>
  );
}

export function PartyGuestPanel({
  partyId,
  guestName,
  guest,
  allergens,
  abilities,
}: {
  partyId: string;
  guestName: string;
  guest: PartyGuestView;
  allergens: AllergenOption[];
  abilities: HostGuestAbilities;
}) {
  const router = useRouter();
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const recorded = new Set(guest.allergies.map((entry) => entry.allergenId));
  const choices = allergens.filter((entry) => entry.active && !recorded.has(entry.id));

  async function call(method: string, url: string, body: Record<string, unknown>) {
    setPending(true);
    setError(null);

    const result = await callOrderApi(method, url, { expectedPartyVersion: guest.partyVersion, ...body });

    setPending(false);

    if (result.ok) {
      setPicking(false);
      router.refresh();
    } else if (result.status === 401) {
      router.push("/login");
    } else {
      setError({ code: result.code, message: result.message, requestId: result.requestId });
    }
  }

  function addAllergy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const data = new FormData(event.currentTarget);

    void call("POST", `/api/guest-parties/${partyId}/allergies`, {
      allergenId: data.get("allergenId"),
      severity: data.get("severity"),
      note: String(data.get("note") ?? "").trim() || null,
      saveToProfile: data.get("saveToProfile") === "on",
    });
  }

  return (
    <section aria-label={`Guest and allergies for ${guestName}`} className="mt-2 grid gap-2 rounded border border-neutral-300 p-3">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Guest profile:</span>
        {guest.profile ? (
          <>
            {abilities.view ? (
              <Link href={`/host/guests/${guest.profile.id}`} className="underline">
                {guest.profile.displayName}
              </Link>
            ) : (
              guest.profile.displayName
            )}
            <span className="text-neutral-500">#{guest.profile.profileNumber}</span>
            {guest.profile.vip && <Badge tone="brand">VIP</Badge>}
            {abilities.manage && (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => call("DELETE", `/api/guest-parties/${partyId}/profile`, {})}
              >
                Unlink
              </Button>
            )}
          </>
        ) : (
          <span className="text-neutral-600">none</span>
        )}
        {abilities.manage && !picking && (
          <Button variant="ghost" onClick={() => setPicking(true)}>
            {guest.profile ? "Change" : "Link a profile"}
          </Button>
        )}
      </p>
      {picking && (
        <GuestPicker
          suggestedName={guestName}
          canCreate={abilities.manage}
          onPick={(picked) => call("PUT", `/api/guest-parties/${partyId}/profile`, { guestProfileId: picked.id })}
        />
      )}

      <div className="grid gap-1 text-sm">
        <span className="font-medium">Allergies this visit:</span>
        {guest.allergies.length === 0 ? (
          <span className="text-neutral-600">none recorded</span>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {guest.allergies.map((entry) => (
              <li key={entry.allergenId} className="flex items-center gap-1">
                <Badge tone={entry.severity === "SEVERE" ? "danger" : "warning"}>
                  {entry.name}
                  {entry.severity === "SEVERE" ? " · severe" : ""}
                </Badge>
                {entry.source === "PROFILE" && <span className="text-xs text-neutral-500">from profile</span>}
                {abilities.manage && (
                  <Button
                    variant="ghost"
                    disabled={pending}
                    aria-label={`Remove ${entry.name} allergy`}
                    onClick={() => call("DELETE", `/api/guest-parties/${partyId}/allergies`, { allergenId: entry.allergenId })}
                  >
                    ×
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {abilities.manage && choices.length > 0 && (
        <form onSubmit={addAllergy} aria-label={`Add allergy for ${guestName}`} className="grid gap-2 sm:grid-cols-3">
          <Field label="Allergen">
            <Select name="allergenId" required>
              {choices.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Severity">
            <Select name="severity" defaultValue="ALLERGY">
              <option value="ALLERGY">Allergy</option>
              <option value="SEVERE">Severe</option>
            </Select>
          </Field>
          <Field label="Note (optional)">
            <Input name="note" maxLength={200} />
          </Field>
          {guest.profile && <Checkbox name="saveToProfile" label="Also save to the profile" className="sm:col-span-3" />}
          <Button type="submit" pending={pending} pendingLabel="Saving…" className="justify-self-start">
            Record allergy
          </Button>
        </form>
      )}
      {error && <ApiErrorMessage error={error} />}
    </section>
  );
}
