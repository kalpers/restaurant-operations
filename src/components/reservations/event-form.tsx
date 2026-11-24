"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiJson, type ApiFailure } from "@/components/forms/api-request";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, FieldHint, Input, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import type { EventSpaceScope } from "@/modules/reservations/rules/event-rules";
import type { EventView } from "@/modules/reservations/services/event-service";

type Failure = Pick<ApiFailure, "code" | "message" | "requestId">;
export type EventFormTable = { id: string; tableNumber: string; capacity: number; areaId: string; areaName: string };

const SCOPES: { value: EventSpaceScope; label: string }[] = [
  { value: "TABLES", label: "Chosen tables (one area)" },
  { value: "AREA", label: "A whole area" },
  { value: "LOCATION", label: "The whole location (buyout)" },
];

/**
 * Phase 36 (policy 7): books or changes an event. The party (contact, guest count) is the
 * event's own Guest Party. Deposits and minimum spend are information only.
 */
export function EventForm({
  event,
  tables,
  menuItems,
  today,
}: {
  event?: EventView;
  tables: EventFormTable[];
  menuItems: { id: string; name: string }[];
  today: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [scope, setScope] = useState<EventSpaceScope>(event?.spaceScope ?? "TABLES");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const areas = [...new Map(tables.map((table) => [table.areaId, table.areaName])).entries()];

  async function handleSubmit(form: FormEvent<HTMLFormElement>) {
    form.preventDefault();

    const data = new FormData(form.currentTarget);
    const text = (name: string) => {
      const value = String(data.get(name) ?? "").trim();

      return value === "" ? null : value;
    };
    const body = {
      name: data.get("name"),
      guestName: data.get("guestName"),
      partySize: Number(data.get("partySize")),
      phone: text("phone"),
      email: text("email"),
      localDate: data.get("localDate"),
      startTime: data.get("startTime"),
      endTime: data.get("endTime"),
      setupMinutes: Number(data.get("setupMinutes") || 0),
      teardownMinutes: Number(data.get("teardownMinutes") || 0),
      spaceScope: scope,
      restaurantAreaId: scope === "AREA" ? text("restaurantAreaId") : null,
      tableIds: scope === "TABLES" ? data.getAll("tableIds") : [],
      notes: text("notes"),
      menuNotes: text("menuNotes"),
      menuItemId: text("menuItemId"),
      minimumSpend: text("minimumSpend"),
      depositAgreed: text("depositAgreed"),
      depositReceived: text("depositReceived"),
      depositReceivedOn: text("depositReceivedOn"),
      depositMethod: text("depositMethod"),
      depositReference: text("depositReference"),
      ...(event ? { expectedVersion: event.version } : { status: data.get("status") }),
    };

    setPending(true);
    setError(null);

    const result = event
      ? await sendApiJson<EventView>("PATCH", `/api/events/${event.id}`, body)
      : await sendApiJson<EventView>("POST", "/api/events", body);

    setPending(false);

    if (result.ok) {
      toast.success(event ? "Event saved." : `${result.data.eventNumber} booked.`);
      router.push(`/events/${result.data.id}`);
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4" aria-label={event ? `Edit ${event.eventNumber}` : "Book an event"}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Event name">
          <Input name="name" required maxLength={120} defaultValue={event?.name ?? ""} />
        </Field>
        {!event && (
          <Field label="Status">
            <Select name="status" defaultValue="INQUIRY">
              <option value="INQUIRY">Inquiry (holds nothing)</option>
              <option value="TENTATIVE">Tentative (holds the space)</option>
              <option value="CONFIRMED">Confirmed</option>
            </Select>
          </Field>
        )}
      </div>
      <fieldset className="grid gap-3 sm:grid-cols-4">
        <legend className="mb-1 text-sm font-medium text-neutral-800">Host</legend>
        <Field label="Contact name">
          <Input name="guestName" required maxLength={200} defaultValue={event?.guestName ?? ""} />
        </Field>
        <Field label="Guests">
          <Input name="partySize" type="number" required min={1} max={1000} defaultValue={event?.partySize ?? 10} />
        </Field>
        <Field label="Phone">
          <Input name="phone" maxLength={40} defaultValue={event?.contact?.phone ?? ""} />
        </Field>
        <Field label="Email">
          <Input name="email" type="email" maxLength={254} defaultValue={event?.contact?.email ?? ""} />
        </Field>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-5">
        <legend className="mb-1 text-sm font-medium text-neutral-800">When</legend>
        <Field label="Date">
          <Input name="localDate" type="date" required min={event ? undefined : today} defaultValue={event?.localDate ?? today} />
        </Field>
        <Field label="Starts">
          <Input name="startTime" type="time" required defaultValue={event?.startTime ?? "18:00"} />
        </Field>
        <Field label="Ends">
          <Input name="endTime" type="time" required defaultValue={event?.endTime ?? "21:00"} />
        </Field>
        <Field label="Setup (minutes)">
          <Input name="setupMinutes" type="number" min={0} max={480} defaultValue={event?.setupMinutes ?? 30} />
        </Field>
        <Field label="Teardown (minutes)">
          <Input name="teardownMinutes" type="number" min={0} max={480} defaultValue={event?.teardownMinutes ?? 30} />
        </Field>
      </fieldset>
      <FieldHint>An end at or before the start runs past midnight. Setup and teardown are held too.</FieldHint>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium text-neutral-800">Space</legend>
        <div className="flex flex-wrap gap-x-4">
          {SCOPES.map((option) => (
            <label key={option.value} className="flex min-h-11 items-center gap-2 text-sm">
              <input type="radio" name="spaceScope" value={option.value} checked={scope === option.value} onChange={() => setScope(option.value)} />
              {option.label}
            </label>
          ))}
        </div>
        {scope === "AREA" && (
          <Field label="Area">
            <Select name="restaurantAreaId" defaultValue={event?.area?.id ?? areas[0]?.[0]}>
              {areas.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {scope === "TABLES" &&
          areas.map(([areaId, areaName]) => (
            <fieldset key={areaId} className="grid gap-1">
              <legend className="text-sm text-neutral-700">{areaName}</legend>
              <div className="flex flex-wrap gap-x-4">
                {tables
                  .filter((table) => table.areaId === areaId)
                  .map((table) => (
                    <Checkbox
                      key={table.id}
                      name="tableIds"
                      value={table.id}
                      label={`Table ${table.tableNumber} (${table.capacity})`}
                      defaultChecked={event?.tables.some((chosen) => chosen.id === table.id) ?? false}
                    />
                  ))}
              </div>
            </fieldset>
          ))}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Set menu (optional)">
          <Select name="menuItemId" defaultValue={event?.menuItem?.id ?? ""}>
            <option value="">None</option>
            {menuItems.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Minimum spend before tax (optional)">
          <Input name="minimumSpend" inputMode="decimal" defaultValue={event?.minimumSpend ?? ""} />
        </Field>
      </div>
      <Field label="Menu notes">
        <Textarea name="menuNotes" maxLength={2000} rows={2} defaultValue={event?.menuNotes ?? ""} />
      </Field>
      <Field label="Notes">
        <Textarea name="notes" maxLength={4000} rows={3} defaultValue={event?.notes ?? ""} />
      </Field>
      <fieldset className="grid gap-3 sm:grid-cols-5">
        <legend className="mb-1 text-sm font-medium text-neutral-800">Deposit (a record only; nothing is charged or held)</legend>
        <Field label="Agreed">
          <Input name="depositAgreed" inputMode="decimal" defaultValue={event?.depositAgreed ?? ""} />
        </Field>
        <Field label="Received">
          <Input name="depositReceived" inputMode="decimal" defaultValue={event?.depositReceived ?? ""} />
        </Field>
        <Field label="Received on">
          <Input name="depositReceivedOn" type="date" defaultValue={event?.depositReceivedOn ?? ""} />
        </Field>
        <Field label="How">
          <Select name="depositMethod" defaultValue={event?.depositMethod ?? ""}>
            <option value="">-</option>
            <option value="CASH">Cash</option>
            <option value="EXTERNAL_CARD">Card (outside the app)</option>
            <option value="OTHER">Other</option>
          </Select>
        </Field>
        <Field label="Reference">
          <Input name="depositReference" maxLength={80} defaultValue={event?.depositReference ?? ""} />
        </Field>
      </fieldset>
      <FieldHint>When the event is settled, enter the deposit as an Other tender, &quot;Event deposit {event?.eventNumber ?? "EV-…"}&quot;.</FieldHint>
      <ApiErrorMessage error={error} />
      <div>
        <Button type="submit" variant="primary" pending={pending} pendingLabel="Saving…">
          {event ? "Save event" : "Book event"}
        </Button>
      </div>
    </form>
  );
}
