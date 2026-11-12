"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiErrorMessage } from "@/components/forms/api-error-message";
import { sendApiRequest, type ApiFailure } from "@/components/forms/api-request";
import { Button } from "@/components/ui/button";
import { INPUT_STYLE } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

type Choice = { id: string; name: string; active: boolean };
type Kind = "CONTAINS" | "MAY_CONTAIN";

type Props =
  | {
      /** An ingredient: each allergen is tagged or not. */
      mode: "tags";
      url: string;
      allergens: Choice[];
      selected: string[];
      reviewVersion: number | null;
    }
  | {
      /** A menu item: each allergen is not declared, contains or may contain. */
      mode: "declared";
      url: string;
      allergens: Choice[];
      declared: { allergenId: string; kind: Kind }[];
      reviewVersion: number | null;
    };

/**
 * Phase 21 (policies 9 and 10): saving replaces the whole list, even when nothing is chosen,
 * and marks it reviewed. Inactive allergens show only where they're already set.
 */
export function AllergenTagsForm(props: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const initial = new Map<string, Kind>(
    props.mode === "tags"
      ? props.selected.map((id) => [id, "CONTAINS"])
      : props.declared.map((entry) => [entry.allergenId, entry.kind]),
  );
  const [values, setValues] = useState(initial);
  const shown = props.allergens.filter((entry) => entry.active || initial.has(entry.id));

  function set(id: string, kind: Kind | null) {
    setValues((current) => {
      const next = new Map(current);

      if (kind) {
        next.set(id, kind);
      } else {
        next.delete(id);
      }

      return next;
    });
  }

  async function save() {
    setPending(true);
    setError(null);
    const body =
      props.mode === "tags"
        ? { allergenIds: [...values.keys()], expectedReviewVersion: props.reviewVersion }
        : {
            declared: [...values.entries()].map(([allergenId, kind]) => ({ allergenId, kind })),
            expectedReviewVersion: props.reviewVersion,
          };
    const result = await sendApiRequest("PUT", props.url, body);
    setPending(false);

    if (result.ok) {
      toast.success("Allergens saved and marked reviewed.");
      router.refresh();
    } else if (result.status === 401) {
      router.push("/login");
    } else {
      setError(result);
    }
  }

  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-2 sm:grid-cols-3">
        <legend className="sr-only">Allergens</legend>
        {shown.map((entry) =>
          props.mode === "tags" ? (
            <label key={entry.id} className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                checked={values.has(entry.id)}
                onChange={(event) => set(entry.id, event.target.checked ? "CONTAINS" : null)}
                className="size-5 accent-brand-700"
              />
              {entry.name}
              {entry.active ? null : <span className="text-xs text-neutral-500">(inactive)</span>}
            </label>
          ) : (
            <label key={entry.id} className="grid gap-1 text-sm font-medium text-neutral-800">
              {entry.name}
              <select
                value={values.get(entry.id) ?? ""}
                onChange={(event) => set(entry.id, (event.target.value || null) as Kind | null)}
                className={INPUT_STYLE}
              >
                <option value="">Not declared</option>
                <option value="CONTAINS">Contains</option>
                <option value="MAY_CONTAIN">May contain</option>
              </select>
            </label>
          ),
        )}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="primary" pending={pending} pendingLabel="Saving..." onClick={save}>
          Save and mark reviewed
        </Button>
        <ApiErrorMessage error={error} />
      </div>
    </div>
  );
}
