"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { NETWORK_FAILURE_MESSAGE, readFailure, type ApiFailure } from "@/components/forms/api-request";
import { apiFetch } from "@/components/forms/page-location";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

// Phase 28 (policy 10): downloads one export file. Fetched rather than linked, so a refusal
// (an unbalanced day, open time entries, a range that isn't whole weeks) shows beside the form.

type Props = {
  kind: "journal" | "payroll";
  label: string;
  locationId: string;
  allLocations: boolean;
  defaultFrom: string;
  defaultTo: string;
};

export function ExportDownload({ kind, label, locationId, allLocations, defaultFrom, defaultTo }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [scope, setScope] = useState(locationId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);

  async function download(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const query = new URLSearchParams({ locationId: scope, from, to });
      const response = await apiFetch(`/api/reports/exports/${kind}?${query.toString()}`);

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      if (!response.ok) {
        setError(await readFailure(response));
        return;
      }

      const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? `${kind}.csv`;
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");

      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success(`${label} downloaded.`);
    } catch {
      setError({ ok: false, status: 0, code: "NETWORK", message: NETWORK_FAILURE_MESSAGE });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={download} aria-label={label} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={kind === "payroll" ? "First day (start of a work week)" : "From business date"}>
          <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} required />
        </Field>
        <Field label={kind === "payroll" ? "Last day (end of a work week)" : "To business date"}>
          <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} required />
        </Field>
        {allLocations ? (
          <Field label="Locations">
            <Select value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value={locationId}>This location</option>
              <option value="ALL">All my locations</option>
            </Select>
          </Field>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          Download {label.toLowerCase()} (CSV)
        </Button>
        <ApiErrorMessage error={error} />
      </div>
    </form>
  );
}
