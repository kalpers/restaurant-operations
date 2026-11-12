"use client";

import { TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { AllergenLabelBadges } from "@/components/allergens/allergen-label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import type { OrderDetail } from "@/modules/orders/queries/order-queries";

import { callOrderApi } from "./order-api";

// Phase 21 (policies 8 and 13): the check's allergies and each item's allergen label. The server
// decides what conflicts; this shows what it returned and sends what staff record.

export type AllergenChoice = { id: string; name: string; active: boolean };

type Failure = { code: string; message: string; requestId?: string };

/** The allergies the warning checks: the party's for a seated table, the check's own otherwise. */
export function AllergyPanel({
  order,
  allergens,
  canEdit,
  canSaveToProfile,
}: {
  order: OrderDetail;
  allergens: AllergenChoice[];
  canEdit: boolean;
  canSaveToProfile: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const { allergy } = order;
  const party = allergy.source === "PARTY" && allergy.guestPartyId !== null;
  const recorded = new Set(allergy.allergies.map((entry) => entry.allergenId));
  const choices = allergens.filter((entry) => entry.active && !recorded.has(entry.id));

  async function send(method: "POST" | "DELETE", body: Record<string, unknown>, allergenId?: string) {
    setPending(true);
    setError(null);

    const url = party
      ? `/api/guest-parties/${allergy.guestPartyId}/allergies`
      : `/api/orders/${order.id}/allergies${method === "DELETE" ? `/${allergenId}` : ""}`;
    const versioned = party ? { expectedPartyVersion: allergy.partyVersion, ...body } : { expectedVersion: order.version, ...body };
    const result = await callOrderApi(method, url, versioned);

    setPending(false);

    if (result.ok) {
      setAdding(false);
      router.refresh();
    } else if (result.status === 401) {
      router.push("/login");
    } else {
      setError({ code: result.code, message: result.message, requestId: result.requestId });
    }
  }

  function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const data = new FormData(event.currentTarget);

    void send("POST", {
      allergenId: data.get("allergenId"),
      severity: data.get("severity"),
      note: String(data.get("note") ?? "").trim() || null,
      ...(party ? { saveToProfile: data.get("saveToProfile") === "on" } : {}),
    });
  }

  const severe = allergy.allergies.some((entry) => entry.severity === "SEVERE");

  return (
    <section
      aria-label="Allergies"
      className={
        allergy.allergies.length > 0
          ? "grid gap-2 rounded-md border-2 border-danger-500 bg-danger-50 p-3"
          : "grid gap-2 rounded-md border border-neutral-200 p-3"
      }
    >
      <h2 className="flex flex-wrap items-center gap-2 font-semibold">
        {allergy.allergies.length > 0 && <TriangleAlert aria-hidden className="size-5 text-danger-700" />}
        Allergies
        {allergy.profile && (
          <span className="text-sm font-normal text-neutral-700">
            · {allergy.profile.displayName}
            {allergy.profile.vip && (
              <Badge tone="brand" className="ml-1">
                VIP
              </Badge>
            )}
          </span>
        )}
      </h2>
      {allergy.allergies.length === 0 ? (
        <p className="text-sm text-neutral-600">None recorded{party ? " for this party" : " for this check"}.</p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label={severe ? "Allergies, some severe" : "Allergies"}>
          {allergy.allergies.map((entry) => (
            <li key={entry.allergenId} className="flex items-center gap-1">
              <Badge tone={entry.severity === "SEVERE" ? "danger" : "warning"}>
                {entry.name}
                {entry.severity === "SEVERE" ? " · severe" : ""}
              </Badge>
              {entry.note && <span className="text-xs text-neutral-700">{entry.note}</span>}
              {canEdit && (
                <Button
                  variant="ghost"
                 
                  disabled={pending}
                  aria-label={`Remove ${entry.name} allergy`}
                  onClick={() => send("DELETE", party ? { allergenId: entry.allergenId } : {}, entry.allergenId)}
                >
                  ×
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && !adding && (
        <Button onClick={() => setAdding(true)} disabled={choices.length === 0} className="justify-self-start">
          Add allergy
        </Button>
      )}
      {canEdit && adding && (
        <form onSubmit={handleAdd} aria-label="Add allergy" className="grid gap-2 sm:grid-cols-2">
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
          <Field label="Note (optional)" className="sm:col-span-2">
            <Input name="note" maxLength={200} />
          </Field>
          {party && allergy.profile && canSaveToProfile && (
            <Checkbox name="saveToProfile" label="Also save to the guest's profile" />
          )}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" variant="primary" pending={pending} pendingLabel="Saving…">
              Record allergy
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && <ApiErrorMessage error={error} className="flex" />}
    </section>
  );
}

/** An item's label, with its conflict (drafts) or acknowledgment (sent items). */
export function ItemAllergenNote({ order, itemId }: { order: OrderDetail; itemId: string }) {
  const view = order.allergy.items[itemId];

  if (!view) {
    return null;
  }

  return (
    <div className="mt-1 grid gap-1">
      <AllergenLabelBadges label={view} compact />
      {view.conflict && (
        <p
          role="alert"
          className={
            view.conflict.severity === "SEVERE"
              ? "rounded border-2 border-danger-600 bg-danger-50 px-2 py-1 text-sm font-bold text-danger-800"
              : "rounded border border-danger-400 bg-danger-50 px-2 py-1 text-sm font-semibold text-danger-800"
          }
        >
          {view.conflict.description}. Check with the guest before sending.
        </p>
      )}
      {view.acknowledged && (
        <p className="text-xs font-medium text-danger-800">Sent after allergy check · {view.acknowledged.description}</p>
      )}
    </div>
  );
}
