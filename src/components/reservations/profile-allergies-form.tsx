"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { callOrderApi } from "@/components/orders/order-api";
import { Button } from "@/components/ui/button";
import { INPUT_STYLE } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

type Severity = "SEVERE" | "ALLERGY";
type Row = { severity: Severity; note: string };

/** Phase 21 (policy 7): a profile's allergies, saved as one list. Open visits follow the profile. */
export function ProfileAllergiesForm({
  profileId,
  version,
  allergens,
  current,
}: {
  profileId: string;
  version: number;
  allergens: { id: string; name: string; active: boolean }[];
  current: { allergenId: string; severity: Severity; note: string | null }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState(
    new Map<string, Row>(current.map((entry) => [entry.allergenId, { severity: entry.severity, note: entry.note ?? "" }])),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; requestId?: string } | null>(null);
  const shown = allergens.filter((entry) => entry.active || rows.has(entry.id));

  function update(id: string, row: Row | null) {
    setRows((existing) => {
      const next = new Map(existing);

      if (row) {
        next.set(id, row);
      } else {
        next.delete(id);
      }

      return next;
    });
  }

  async function save() {
    setPending(true);
    setError(null);

    const result = await callOrderApi("PUT", `/api/guests/${profileId}/allergies`, {
      expectedVersion: version,
      allergies: [...rows.entries()].map(([allergenId, row]) => ({
        allergenId,
        severity: row.severity,
        note: row.note.trim() || null,
      })),
    });

    setPending(false);

    if (result.ok) {
      toast.success("Allergies saved.");
      router.refresh();
    } else {
      setError({ code: result.code, message: result.message, requestId: result.requestId });
    }
  }

  return (
    <div className="grid gap-3">
      <ul className="grid gap-2 sm:grid-cols-2">
        {shown.map((entry) => {
          const row = rows.get(entry.id);

          return (
            <li key={entry.id} className="grid gap-1 rounded border border-neutral-200 p-2">
              <label className="grid gap-1 text-sm font-medium">
                {entry.name}
                <select
                  value={row?.severity ?? ""}
                  onChange={(event) =>
                    update(entry.id, event.target.value ? { severity: event.target.value as Severity, note: row?.note ?? "" } : null)
                  }
                  className={INPUT_STYLE}
                >
                  <option value="">Not allergic</option>
                  <option value="ALLERGY">Allergy</option>
                  <option value="SEVERE">Severe</option>
                </select>
              </label>
              {row && (
                <label className="grid gap-1 text-xs font-medium text-neutral-700">
                  Note
                  <input
                    value={row.note}
                    maxLength={200}
                    onChange={(event) => update(entry.id, { ...row, note: event.target.value })}
                    className={INPUT_STYLE}
                  />
                </label>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={save} pending={pending} pendingLabel="Saving…">
          Save allergies
        </Button>
        {error && <ApiErrorMessage error={error} />}
      </div>
    </div>
  );
}
