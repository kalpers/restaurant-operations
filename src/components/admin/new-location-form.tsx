"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiRequest, type ApiFailure } from "@/components/forms/api-request";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, FieldHint, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

// Phase 23 (policies 1–2): opens a new location. The copy groups are what the server
// copies from the chosen location; staff, tables, stock and history are never copied.

const GROUPS = [
  { value: "SETTINGS", label: "Location settings (business day, reservations, stock rules, drawers)" },
  { value: "STATIONS_AND_ROUTING", label: "Prep stations and kitchen routing" },
  { value: "MENUS", label: "Menus offered and their hours" },
  { value: "PRICES", label: "Menu prices set for that location" },
  { value: "TAX_RATES", label: "Tax rates" },
  { value: "STOCKED_ITEMS", label: "Stocked items with par and reorder levels (no stock)" },
  { value: "SCHEDULING_RULES", label: "Scheduling rules" },
  { value: "TIP_POOL_RULES", label: "Tip pool rule" },
  { value: "BOOKING_HOURS", label: "Online booking settings and hours (booking stays off)" },
] as const;

type Props = {
  sources: { id: string; name: string }[];
  defaultTimeZone: string;
};

export function NewLocationForm({ sources, defaultTimeZone }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [source, setSource] = useState("");
  const [groups, setGroups] = useState<Set<string>>(new Set(GROUPS.map((group) => group.value)));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (name: string) => {
      const value = String(data.get(name) ?? "").trim();
      return value === "" ? null : value;
    };

    setPending(true);
    setError(null);
    const result = await sendApiRequest("POST", "/api/admin/locations", {
      name: text("name"),
      locationCode: text("locationCode"),
      timezone: text("timezone"),
      addressLine1: text("addressLine1"),
      city: text("city"),
      state: text("state"),
      postalCode: text("postalCode"),
      phone: text("phone"),
      copyFrom: source ? { locationId: source, groups: [...groups] } : null,
    });
    setPending(false);

    if (result.ok) {
      form.reset();
      toast.success("Location opened. Switch to it to finish setting it up.");
      router.refresh();
    } else {
      setError(result);
    }
  }

  function toggle(value: string, on: boolean) {
    setGroups((current) => {
      const next = new Set(current);
      if (on) {
        next.add(value);
      } else {
        next.delete(value);
      }
      return next;
    });
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4" aria-label="New location">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input name="name" required maxLength={200} />
        </Field>
        <Field label="Code">
          <Input name="locationCode" required pattern="[A-Za-z0-9]{2,12}" maxLength={12} autoComplete="off" />
        </Field>
        <Field label="Time zone">
          <Input name="timezone" required defaultValue={defaultTimeZone} />
        </Field>
        <Field label="Phone">
          <Input name="phone" maxLength={200} />
        </Field>
        <Field label="Address">
          <Input name="addressLine1" maxLength={200} />
        </Field>
        <Field label="City">
          <Input name="city" maxLength={200} />
        </Field>
        <Field label="State">
          <Input name="state" maxLength={200} />
        </Field>
        <Field label="Postal code">
          <Input name="postalCode" maxLength={200} />
        </Field>
      </div>
      <FieldHint>Code: 2 to 12 letters or digits, such as UPTOWN. The online booking page uses it.</FieldHint>

      <Field label="Copy setup from">
        <Select value={source} onChange={(event) => setSource(event.target.value)}>
          <option value="">Nothing: start with defaults</option>
          {sources.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </Select>
      </Field>

      {source && (
        <fieldset className="grid gap-1 rounded-md border border-neutral-200 p-3">
          <legend className="px-1 text-sm font-semibold">What to copy</legend>
          {GROUPS.map((group) => (
            <Checkbox
              key={group.value}
              label={group.label}
              checked={groups.has(group.value)}
              onChange={(event) => toggle(group.value, event.target.checked)}
            />
          ))}
          <FieldHint>Never copied: tables, staff and their access, stock, schedules, reservations and orders.</FieldHint>
        </fieldset>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" pending={pending} pendingLabel="Opening…">
          Open location
        </Button>
        <ApiErrorMessage error={error} />
      </div>
    </form>
  );
}
