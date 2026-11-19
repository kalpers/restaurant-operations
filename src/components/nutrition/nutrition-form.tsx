"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiRequest, type ApiFailure } from "@/components/forms/api-request";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

// Phase 28 (policies 11 and 12): edit an ingredient's nutrition (per an amount of its base unit)
// or a menu item's declared figures. A blank field means "no data", never zero.

const FIELDS = [
  ["calories", "Calories"],
  ["fatG", "Total fat (g)"],
  ["saturatedFatG", "Saturated fat (g)"],
  ["carbohydrateG", "Carbohydrate (g)"],
  ["sugarsG", "Sugars (g)"],
  ["fibreG", "Fibre (g)"],
  ["proteinG", "Protein (g)"],
  ["sodiumMg", "Sodium (mg)"],
] as const;

type Values = Record<(typeof FIELDS)[number][0], string | null>;

type Props = {
  url: string;
  version: number | null;
  values: Values | null;
  /** Ingredients: the amount of the base unit the figures are for. */
  basis?: { quantity: string; unit: string } | null;
  /** Menu items: offer to remove declared figures. */
  removable?: boolean;
};

const trimZeros = (value: string | null) => (value === null ? "" : value.replace(/\.?0+$/, ""));

export function NutritionForm({ url, version, values, basis, removable }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState<Record<string, string>>(
    Object.fromEntries(FIELDS.map(([key]) => [key, trimZeros(values?.[key] ?? null)])),
  );
  const [basisQuantity, setBasisQuantity] = useState(basis ? trimZeros(basis.quantity) : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);

  async function send(body: unknown, message: string) {
    setPending(true);
    setError(null);
    const result = await sendApiRequest("PUT", url, body);
    setPending(false);

    if (result.ok) {
      toast.success(message);
      router.refresh();
    } else if (result.status === 401) {
      router.push("/login");
    } else {
      setError(result);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();

    const entries = Object.fromEntries(FIELDS.map(([key]) => [key, form[key]?.trim() ? form[key]!.trim() : null]));

    void send(
      basis !== undefined ? { basisQuantity, values: entries, expectedVersion: version } : { values: entries, expectedVersion: version },
      "Nutrition saved.",
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-3" aria-label="Nutrition">
      {basis !== undefined ? (
        <Field label={`Figures are for this many ${basis?.unit ?? "base units"}`}>
          <Input inputMode="decimal" value={basisQuantity} onChange={(event) => setBasisQuantity(event.target.value)} required />
        </Field>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-4">
        {FIELDS.map(([key, label]) => (
          <Field key={key} label={label}>
            <Input
              inputMode="decimal"
              value={form[key] ?? ""}
              onChange={(event) => setForm({ ...form, [key]: event.target.value })}
            />
          </Field>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          Save nutrition
        </Button>
        {removable && version !== null ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => void send({ values: {}, remove: true, expectedVersion: version }, "Declared nutrition removed.")}
          >
            Use the recipe instead
          </Button>
        ) : null}
        <ApiErrorMessage error={error} />
      </div>
    </form>
  );
}
