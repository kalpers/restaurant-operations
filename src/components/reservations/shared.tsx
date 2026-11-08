"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { sendApiRequest } from "@/components/forms/api-request";

export const INPUT_CLASS =
  "min-h-11 w-full rounded border border-neutral-300 bg-white px-3 py-2 text-base";
export const BUTTON_CLASS =
  "min-h-11 rounded border border-neutral-400 px-3 py-1 text-sm font-medium disabled:opacity-50";
export const PRIMARY_CLASS =
  "min-h-11 rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50";

export type HostTableOption = {
  id: string;
  tableNumber: string;
  capacity: number;
  areaId: string;
  areaName: string;
  availability: "AVAILABLE" | "DIRTY" | "OUT_OF_SERVICE" | "OCCUPIED" | "INACTIVE";
  held: boolean;
};

/** Posts a change, refreshes the page on success, and keeps any error for display. */
export function useSubmit() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(method: string, url: string, body: unknown): Promise<boolean> {
    setPending(true);
    setError(null);

    const result = await sendApiRequest(method, url, body);

    setPending(false);

    if (result.ok) {
      router.refresh();

      return true;
    }

    if (result.status === 401) {
      router.push("/login");
    } else {
      setError(result.message);
    }

    return false;
  }

  return { submit, pending, error, clearError: () => setError(null) };
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-red-700">
      {error}
    </p>
  ) : null;
}

export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}

export function formatDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(iso));
}

export function minutesBetween(fromIso: string, to: Date): number {
  return Math.max(0, Math.floor((+to - +new Date(fromIso)) / 60_000));
}

export const AVAILABILITY_TEXT: Record<HostTableOption["availability"], string> = {
  AVAILABLE: "Available",
  DIRTY: "Dirty",
  OUT_OF_SERVICE: "Out of service",
  OCCUPIED: "Occupied",
  INACTIVE: "Inactive",
};

/**
 * A checklist of tables. Held tables stay selectable but are marked, since a hold is a
 * planning protection and not occupancy.
 */
export function TablePicker({
  legend,
  tables,
  chosen,
  onToggle,
  onlyAvailable = false,
}: {
  legend: string;
  tables: readonly HostTableOption[];
  chosen: readonly string[];
  onToggle: (id: string) => void;
  onlyAvailable?: boolean;
}) {
  const shown = onlyAvailable
    ? tables.filter((table) => table.availability === "AVAILABLE")
    : tables;

  return (
    <fieldset className="grid gap-1">
      <legend className="text-sm font-medium">{legend}</legend>
      {shown.length === 0 && (
        <p className="text-sm text-neutral-600">No tables are free.</p>
      )}
      <div className="flex flex-wrap gap-3">
        {shown.map((table) => (
          <label
            key={table.id}
            className="flex min-h-11 items-center gap-2 rounded border border-neutral-200 px-2"
          >
            <input
              type="checkbox"
              checked={chosen.includes(table.id)}
              onChange={() => onToggle(table.id)}
              className="size-5"
              aria-label={`${table.tableNumber}`}
            />
            <span>
              {table.tableNumber}
              <span className="text-sm text-neutral-600">
                {" "}
                · seats {table.capacity}
                {table.availability !== "AVAILABLE"
                  ? ` · ${AVAILABILITY_TEXT[table.availability]}`
                  : ""}
                {table.held ? " · Reservation hold" : ""}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function toggled(current: readonly string[], id: string): string[] {
  return current.includes(id)
    ? current.filter((value) => value !== id)
    : [...current, id];
}
