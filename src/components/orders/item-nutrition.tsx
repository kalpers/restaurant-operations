"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/components/forms/page-location";
import { figureText } from "@/components/nutrition/nutrition-facts";
import { FIGURE_LABELS, NUTRITION_FIGURES, type NutritionLabel } from "@/modules/recipes/rules/nutrition-label";

// Phase 28 (policy 16): calories for the item with the choices made so far, and the other
// figures in a disclosure, so staff can answer a guest at the table. Worked out by the server
// (`/api/menu/nutrition-quote`) the way SEND resolves the ingredients; nothing is stored.

type Props = { menuItemId: string; selections: { modifierGroupId: string; modifierId: string }[] };

export function ItemNutrition({ menuItemId, selections }: Props) {
  const [label, setLabel] = useState<NutritionLabel | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "choose" | "failed">("loading");
  const key = JSON.stringify(selections);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await apiFetch("/api/menu/nutrition-quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ menuItemId, selections: JSON.parse(key) }),
        });

        if (cancelled) {
          return;
        }

        if (response.ok) {
          setLabel((await response.json()) as NutritionLabel);
          setState("ready");
        } else {
          // Usually a required choice not made yet; the quote needs a valid selection.
          setState(response.status === 422 || response.status === 400 ? "choose" : "failed");
        }
      } catch {
        if (!cancelled) {
          setState("failed");
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [menuItemId, key]);

  if (state === "loading" || state === "failed") {
    return null;
  }

  if (state === "choose" || !label) {
    return <p className="text-sm text-neutral-600">Make the required choices to see nutrition.</p>;
  }

  if (label.source === "NONE") {
    return <p className="text-sm text-neutral-600">No nutrition data for this item.</p>;
  }

  return (
    <details className="text-sm" aria-label="Nutrition">
      <summary className="cursor-pointer">
        <span className="font-medium">Calories: {figureText(label, "calories")}</span>{" "}
        <span className="text-neutral-600">· Nutrition</span>
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        {NUTRITION_FIGURES.map((figure) => (
          <div key={figure} className="contents">
            <dt className="text-neutral-800">{FIGURE_LABELS[figure].name}</dt>
            <dd className="tabular">{figureText(label, figure)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
