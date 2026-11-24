"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiRequest, type ApiFailure } from "@/components/forms/api-request";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox, Field, FieldHint, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { TEMPERATURE_POINT_KINDS, type TemperaturePointKind, type TemperatureUnit } from "@/db/schema/food-safety";
import type { TemperaturePointView } from "@/modules/restaurant/services/temperature-service";

type Failure = Pick<ApiFailure, "code" | "message" | "requestId">;

export const TEMPERATURE_KIND_LABELS: Record<TemperaturePointKind, string> = {
  COLD_HOLDING: "Cold holding",
  FROZEN: "Frozen",
  HOT_HOLDING: "Hot holding",
  COOKING: "Cooking",
  COOLING: "Cooling",
  RECEIVING: "Receiving",
  OTHER: "Other",
};

/** Phase 36 (policy 6): managers set up what's checked, its safe range and how often. */
export function TemperaturePointsManager({ points, defaultUnit }: { points: TemperaturePointView[]; defaultUnit: TemperatureUnit }) {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="grid gap-6">
      <Card>
        <h2 className="mb-3 text-lg font-semibold">New check point</h2>
        <PointForm defaultUnit={defaultUnit} onDone={() => undefined} />
      </Card>
      {points.length === 0 ? (
        <EmptyState title="No check points yet">Add the coolers, freezers and hot wells to check.</EmptyState>
      ) : (
        <ul className="grid gap-3">
          {points.map((point) => (
            <li key={point.id}>
              <Card className="grid gap-2" data-testid="temperature-point">
                {editing === point.id ? (
                  <PointForm point={point} defaultUnit={defaultUnit} onDone={() => setEditing(null)} />
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{point.name}</h3>
                    <Badge>{TEMPERATURE_KIND_LABELS[point.kind]}</Badge>
                    <span className="text-sm text-neutral-700">Safe range {point.rangeText}</span>
                    <span className="text-sm text-neutral-700">
                      {point.checkIntervalMinutes ? `Every ${point.checkIntervalMinutes} minutes` : "No schedule"}
                    </span>
                    {!point.active && <Badge tone="danger">Inactive</Badge>}
                    <Button variant="secondary" onClick={() => setEditing(point.id)}>
                      Edit
                    </Button>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PointForm({ point, defaultUnit, onDone }: { point?: TemperaturePointView; defaultUnit: TemperatureUnit; onDone: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const unit = point?.unit ?? defaultUnit;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (name: string) => {
      const value = String(data.get(name) ?? "").trim();

      return value === "" ? null : value;
    };
    const interval = text("checkIntervalMinutes");
    const body = {
      name: data.get("name"),
      kind: data.get("kind"),
      minimumValue: text("minimumValue"),
      maximumValue: text("maximumValue"),
      checkIntervalMinutes: interval === null ? null : Number(interval),
      sortOrder: Number(data.get("sortOrder") ?? 0),
      ...(point ? { active: data.get("active") === "on", expectedVersion: point.version } : { unit: data.get("unit") }),
    };

    setPending(true);
    setError(null);

    const result = point
      ? await sendApiRequest("PATCH", `/api/temperature-log/points/${point.id}`, body)
      : await sendApiRequest("POST", "/api/temperature-log/points", body);

    setPending(false);

    if (result.ok) {
      if (!point) {
        form.reset();
      }

      toast.success(point ? "Check point saved." : "Check point added.");
      onDone();
      router.refresh();
    } else {
      setError(result);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-3" aria-label={point ? `Edit ${point.name}` : "New check point"}>
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <Field label="Name">
          <Input name="name" required maxLength={80} defaultValue={point?.name ?? ""} />
        </Field>
        <Field label="Kind">
          <Select name="kind" defaultValue={point?.kind ?? "COLD_HOLDING"}>
            {TEMPERATURE_POINT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {TEMPERATURE_KIND_LABELS[kind]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        {point ? (
          <Field label="Unit">
            <Input value={`°${point.unit}`} readOnly disabled />
          </Field>
        ) : (
          <Field label="Unit">
            <Select name="unit" defaultValue={defaultUnit}>
              <option value="F">°F</option>
              <option value="C">°C</option>
            </Select>
          </Field>
        )}
        <Field label={`Lowest safe (°${unit})`}>
          <Input name="minimumValue" inputMode="decimal" defaultValue={point?.minimumValue ?? ""} />
        </Field>
        <Field label={`Highest safe (°${unit})`}>
          <Input name="maximumValue" inputMode="decimal" defaultValue={point?.maximumValue ?? ""} />
        </Field>
        <Field label="Check every (minutes)">
          <Input name="checkIntervalMinutes" type="number" min={30} max={1440} defaultValue={point?.checkIntervalMinutes ?? ""} />
        </Field>
      </div>
      <FieldHint>Leave a bound empty for no limit on that side. The unit can&apos;t change after the point is added.</FieldHint>
      <Field label="Order">
        <Input name="sortOrder" type="number" min={0} max={10000} defaultValue={point?.sortOrder ?? 0} />
      </Field>
      {point && <Checkbox name="active" label="In use" defaultChecked={point.active} />}
      <ApiErrorMessage error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" pending={pending} pendingLabel="Saving…">
          {point ? "Save check point" : "Add check point"}
        </Button>
        {point && (
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
