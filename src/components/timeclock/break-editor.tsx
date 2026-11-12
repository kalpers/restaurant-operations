"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiRequest, type ApiFailure } from "@/components/forms/api-request";
import { useLocationTimeZone } from "@/components/time/location-time-zone";
import { Button } from "@/components/ui/button";
import { INPUT_STYLE } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { toLocalInputValue } from "@/shared/time/format-instant";
import { localToInstant } from "@/shared/time/zoned-time";

// Phase 20 (policy 10, D8): a manager adds, changes or removes an entry's breaks, in the
// location's time, through the Phase 18 adjust PATCH with its required reason. The Phase 18
// break rules (inside the entry, no overlap) give the errors.

type BreakChange =
  | { kind: "REMOVE"; id: string }
  | { kind: "ADD"; startedAt: string; endedAt: string; paid: boolean }
  | { kind: "UPDATE"; id: string; startedAt: string; endedAt: string; paid: boolean };

type BreakRow = {
  /** Null for a break added in this form. */
  id: string | null;
  startedAt: string;
  endedAt: string;
  paid: boolean;
  remove: boolean;
  original?: { startedAt: string; endedAt: string; paid: boolean };
};

function toInstant(value: string, timeZone: string): string | null {
  const [date = "", time = ""] = value.split("T");

  return value ? (localToInstant(date, time, timeZone)?.toISOString() ?? null) : null;
}

export function BreakEditor({
  entry,
}: {
  entry: {
    id: string;
    version: number;
    breaks: { id: string; startedAt: string; endedAt: string | null; paid: boolean }[];
  };
}) {
  const timeZone = useLocationTimeZone();
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState<BreakRow[]>(() =>
    entry.breaks.map((span) => {
      const startedAt = toLocalInputValue(span.startedAt, timeZone);
      const endedAt = toLocalInputValue(span.endedAt, timeZone);

      return { id: span.id, startedAt, endedAt, paid: span.paid, remove: false, original: { startedAt, endedAt, paid: span.paid } };
    }),
  );
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const update = (index: number, change: Partial<BreakRow>) =>
    setRows((current) => current.map((row, position) => (position === index ? { ...row, ...change } : row)));

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const changes = rows.flatMap((row): BreakChange[] => {
      if (row.id && row.remove) {
        return [{ kind: "REMOVE", id: row.id }];
      }

      const startedAt = toInstant(row.startedAt, timeZone);
      const endedAt = toInstant(row.endedAt, timeZone);

      if (!row.id) {
        return startedAt && endedAt ? [{ kind: "ADD", startedAt, endedAt, paid: row.paid }] : [];
      }

      const changed =
        row.startedAt !== row.original?.startedAt || row.endedAt !== row.original?.endedAt || row.paid !== row.original?.paid;

      return changed && startedAt && endedAt
        ? [{ kind: "UPDATE", id: row.id, startedAt, endedAt, paid: row.paid }]
        : [];
    });

    if (changes.length === 0) {
      setError({ ok: false, status: 400, code: "NO_CHANGES", message: "Change, add or remove a break first." });
      return;
    }

    setPending(true);
    setError(null);
    const result = await sendApiRequest("PATCH", `/api/timeclock/entries/${entry.id}`, {
      expectedVersion: entry.version,
      reason,
      breaks: changes,
    });
    setPending(false);

    if (result.ok) {
      toast.success("Breaks saved.");
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Edit breaks" className="grid gap-3">
      <p className="text-sm font-medium">Breaks (location time)</p>
      {rows.length === 0 && <p className="text-sm text-neutral-600">No breaks on this entry.</p>}
      {rows.map((row, index) => (
        <fieldset key={row.id ?? `new-${index}`} className="grid gap-2 rounded-md border border-neutral-200 p-2 sm:grid-cols-4">
          <legend className="px-1 text-xs text-neutral-600">{row.id ? `Break ${index + 1}` : "New break"}</legend>
          <label className="grid gap-1 text-sm">
            Start
            <input
              type="datetime-local"
              className={INPUT_STYLE}
              value={row.startedAt}
              disabled={row.remove}
              onChange={(event) => update(index, { startedAt: event.target.value })}
            />
          </label>
          <label className="grid gap-1 text-sm">
            End
            <input
              type="datetime-local"
              className={INPUT_STYLE}
              value={row.endedAt}
              disabled={row.remove}
              onChange={(event) => update(index, { endedAt: event.target.value })}
            />
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={row.paid} disabled={row.remove} onChange={(event) => update(index, { paid: event.target.checked })} />
            Paid
          </label>
          {row.id && (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={row.remove} onChange={(event) => update(index, { remove: event.target.checked })} />
              Remove
            </label>
          )}
        </fieldset>
      ))}
      <div>
        <Button
          type="button"
          onClick={() => setRows((current) => [...current, { id: null, startedAt: "", endedAt: "", paid: false, remove: false }])}
        >
          Add a break
        </Button>
      </div>
      <label className="grid gap-1 text-sm font-medium">
        Why change the breaks?
        <input className={INPUT_STYLE} value={reason} required maxLength={300} onChange={(event) => setReason(event.target.value)} />
      </label>
      <div>
        <Button type="submit" variant="primary" pending={pending} disabled={!reason.trim()}>
          Save breaks
        </Button>
      </div>
      {error && <ApiErrorMessage error={error} />}
    </form>
  );
}
