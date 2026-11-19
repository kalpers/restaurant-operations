"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiRequest, type ApiFailure } from "@/components/forms/api-request";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

// Phase 28 price period form (policies 2 and 3): days, local times, order types, optional
// dates and a fixed price per item. Shape only; the server checks every rule.

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const ORDER_TYPE_LABELS: Record<string, string> = { DINE_IN: "Dine-in", BAR: "Bar", TAKEOUT: "Takeout" };

export type EditablePeriod = {
  id: string;
  version: number;
  name: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  orderTypes: string[] | null;
  firstDate: string | null;
  lastDate: string | null;
  items: { menuItemId: string; price: string }[];
};

type Props = {
  menuItems: { id: string; name: string; code: string }[];
  period?: EditablePeriod;
};

export function PricePeriodEditor({ menuItems, period }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(period?.name ?? "Happy hour");
  const [days, setDays] = useState<number[]>(period?.daysOfWeek ?? [1, 2, 3, 4, 5]);
  const [startTime, setStartTime] = useState(period?.startTime ?? "16:00");
  const [endTime, setEndTime] = useState(period?.endTime ?? "18:00");
  const [orderTypes, setOrderTypes] = useState<string[]>(period?.orderTypes ?? []);
  const [firstDate, setFirstDate] = useState(period?.firstDate ?? "");
  const [lastDate, setLastDate] = useState(period?.lastDate ?? "");
  const [items, setItems] = useState(period?.items ?? [{ menuItemId: "", price: "" }]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const prefix = period ? `period-${period.id}` : "new-period";

  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const body = {
      name,
      daysOfWeek: [...days].sort(),
      startTime,
      endTime,
      orderTypes: orderTypes.length === 0 ? null : orderTypes,
      firstDate: firstDate || null,
      lastDate: lastDate || null,
      items: items.filter((item) => item.menuItemId !== ""),
      ...(period ? { expectedVersion: period.version } : {}),
    };
    const result = period
      ? await sendApiRequest("PUT", `/api/menu/price-periods/${period.id}`, body)
      : await sendApiRequest("POST", "/api/menu/price-periods", body);

    setPending(false);

    if (result.ok) {
      toast.success(period ? "Price period saved." : "Price period added.");
      router.refresh();
    } else if (result.status === 401) {
      router.push("/login");
    } else {
      setError(result);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4" aria-label={period ? `Edit ${period.name}` : "Add a price period"}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name">
          <Input value={name} onChange={(event) => setName(event.target.value)} required maxLength={60} />
        </Field>
        <Field label="Starts (local time)">
          <Input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} required />
        </Field>
        <Field label="Ends (local time)">
          <Input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} required />
        </Field>
      </div>
      <p className="text-sm text-neutral-600">An end at or before the start runs past midnight and belongs to the start day.</p>

      <fieldset>
        <legend className="mb-1 text-sm font-medium text-neutral-800">Days it starts on</legend>
        <div className="flex flex-wrap gap-x-4">
          {DAY_NAMES.map((day, index) => (
            <Checkbox
              key={day}
              label={day}
              checked={days.includes(index)}
              onChange={() => setDays(toggle(days, index))}
            />
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-sm font-medium text-neutral-800">Order types (none ticked: all)</legend>
        <div className="flex flex-wrap gap-x-4">
          {Object.entries(ORDER_TYPE_LABELS).map(([code, label]) => (
            <Checkbox
              key={code}
              label={label}
              checked={orderTypes.includes(code)}
              onChange={() => setOrderTypes(toggle(orderTypes, code))}
            />
          ))}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First date (optional)">
          <Input type="date" value={firstDate} onChange={(event) => setFirstDate(event.target.value)} />
        </Field>
        <Field label="Last date (optional)">
          <Input type="date" value={lastDate} onChange={(event) => setLastDate(event.target.value)} />
        </Field>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium text-neutral-800">Items and their period price</legend>
        {items.map((item, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
            <Field label={`Item ${index + 1}`}>
              <Select
                id={`${prefix}-item-${index}`}
                value={item.menuItemId}
                onChange={(event) =>
                  setItems(items.map((entry, at) => (at === index ? { ...entry, menuItemId: event.target.value } : entry)))
                }
              >
                <option value="">Choose an item</option>
                {menuItems.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name} ({option.code})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`Price ${index + 1}`}>
              <Input
                inputMode="decimal"
                value={item.price}
                onChange={(event) =>
                  setItems(items.map((entry, at) => (at === index ? { ...entry, price: event.target.value } : entry)))
                }
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setItems(items.filter((_, at) => at !== index))}
              disabled={items.length === 1}
            >
              Remove item
            </Button>
          </div>
        ))}
        <div>
          <Button type="button" variant="secondary" onClick={() => setItems([...items, { menuItemId: "", price: "" }])}>
            Add another item
          </Button>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {period ? "Save price period" : "Add price period"}
        </Button>
        <ApiErrorMessage error={error} />
      </div>
    </form>
  );
}
