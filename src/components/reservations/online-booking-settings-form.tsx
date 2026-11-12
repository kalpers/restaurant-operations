"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Checkbox, Field, FieldHint, Input, Select, Textarea } from "@/components/ui/field";
import type { OnlineBookingSettingsView } from "@/modules/reservations/services/online-booking-service";

import { ErrorText, useSubmit } from "./shared";

// Phase 22 (policy 7): online booking settings and booking hours, for `reservations.online.manage`.

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Period = { weekday: number; startsAt: string; endsAt: string };

export function OnlineBookingSettingsForm({ settings, bookingUrl }: { settings: OnlineBookingSettingsView; bookingUrl: string }) {
  const save = useSubmit();
  const hours = useSubmit();
  const [values, setValues] = useState({
    enabled: settings.enabled,
    requiresApproval: settings.requiresApproval,
    maxPartySize: settings.maxPartySize,
    minLeadMinutes: settings.minLeadMinutes,
    maxDaysAhead: settings.maxDaysAhead,
    slotIntervalMinutes: settings.slotIntervalMinutes,
    maxCoversPerSlot: settings.maxCoversPerSlot,
    reminderHoursBefore: settings.reminderHoursBefore,
    publicNote: settings.publicNote ?? "",
  });
  const [periods, setPeriods] = useState<Period[]>(settings.periods);
  const number = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((current) => ({ ...current, [key]: Number(event.target.value) }));

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    await save.submit("PUT", "/api/reservations/online-settings", {
      ...values,
      publicNote: values.publicNote || null,
      expectedVersion: settings.version,
    });
  }

  return (
    <div className="grid gap-6">
      <Card>
        <CardTitle>Online booking</CardTitle>
        <form onSubmit={handleSave} aria-label="Online booking settings" className="grid gap-4">
          <Checkbox
            label="Take bookings online"
            checked={values.enabled}
            onChange={(event) => setValues((current) => ({ ...current, enabled: event.target.checked }))}
          />
          <p className="text-sm">
            Guests book at{" "}
            <a className="break-all font-medium text-brand-800 underline" href={bookingUrl}>
              {bookingUrl}
            </a>
          </p>
          <Checkbox
            label="Hold online bookings until a host confirms them"
            checked={values.requiresApproval}
            onChange={(event) => setValues((current) => ({ ...current, requiresApproval: event.target.checked }))}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Largest party online">
              <Input type="number" min={1} max={50} required value={values.maxPartySize} onChange={number("maxPartySize")} />
            </Field>
            <Field label="Most guests starting in one time slot">
              <Input type="number" min={1} max={1000} required value={values.maxCoversPerSlot} onChange={number("maxCoversPerSlot")} />
            </Field>
            <Field label="Time slots every">
              <Select value={values.slotIntervalMinutes} onChange={number("slotIntervalMinutes")}>
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={60}>60 minutes</option>
              </Select>
            </Field>
            <Field label="Book at least (minutes ahead)">
              <Input type="number" min={0} max={10080} required value={values.minLeadMinutes} onChange={number("minLeadMinutes")} />
            </Field>
            <Field label="Book up to (days ahead)">
              <Input type="number" min={1} max={365} required value={values.maxDaysAhead} onChange={number("maxDaysAhead")} />
            </Field>
            <Field label="Reminder (hours before, 0 for none)">
              <Input type="number" min={0} max={168} required value={values.reminderHoursBefore} onChange={number("reminderHoursBefore")} />
            </Field>
          </div>
          <FieldHint>Reminders go to every confirmed booking whose guest agreed to messages, booked online or not.</FieldHint>
          <Field label="Note on the booking page (optional)">
            <Textarea
              maxLength={500}
              rows={2}
              value={values.publicNote}
              onChange={(event) => setValues((current) => ({ ...current, publicNote: event.target.value }))}
            />
          </Field>
          <ErrorText error={save.error} />
          <div>
            <Button type="submit" disabled={save.pending}>
              Save settings
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardTitle>Booking hours</CardTitle>
        <p className="mb-3 text-sm text-neutral-700">
          When online bookings may start, in local time. Guests see times inside these hours that still have room.
        </p>
        <ul className="mb-3 grid gap-2" aria-label="Booking hours">
          {periods.length === 0 && <li className="text-sm text-neutral-600">No hours yet: guests can&apos;t book online.</li>}
          {periods.map((period, index) => (
            <li key={index} className="flex flex-wrap items-end gap-2">
              <Field label="Day">
                <Select
                  value={period.weekday}
                  onChange={(event) =>
                    setPeriods((current) => current.map((row, at) => (at === index ? { ...row, weekday: Number(event.target.value) } : row)))
                  }
                >
                  {WEEKDAYS.map((day, weekday) => (
                    <option key={day} value={weekday}>
                      {day}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="From">
                <Input
                  type="time"
                  required
                  value={period.startsAt}
                  onChange={(event) =>
                    setPeriods((current) => current.map((row, at) => (at === index ? { ...row, startsAt: event.target.value } : row)))
                  }
                />
              </Field>
              <Field label="Until">
                <Input
                  type="time"
                  required
                  value={period.endsAt}
                  onChange={(event) =>
                    setPeriods((current) => current.map((row, at) => (at === index ? { ...row, endsAt: event.target.value } : row)))
                  }
                />
              </Field>
              <Button variant="ghost" onClick={() => setPeriods((current) => current.filter((_, at) => at !== index))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setPeriods((current) => [...current, { weekday: 5, startsAt: "17:00", endsAt: "21:00" }])}>
            Add hours
          </Button>
          <Button
            variant="secondary"
            onClick={() => setPeriods([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startsAt: "17:00", endsAt: "21:00" })))}
          >
            Every day 17:00 to 21:00
          </Button>
          <Button disabled={hours.pending} onClick={() => hours.submit("PUT", "/api/reservations/online-settings/periods", { periods })}>
            Save hours
          </Button>
        </div>
        <ErrorText error={hours.error} />
      </Card>
    </div>
  );
}
