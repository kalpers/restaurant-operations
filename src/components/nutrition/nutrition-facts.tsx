import { Badge } from "@/components/ui/badge";
import { FIGURE_LABELS, NUTRITION_FIGURES, type NutritionLabel } from "@/modules/recipes/rules/nutrition-label";

// Phase 28 (policy 12): a nutrition label as text. An incomplete figure is never shown as a
// plain number: it reads "at least N" with how many ingredients have no data, or "No data".

export function figureText(label: NutritionLabel, figure: (typeof NUTRITION_FIGURES)[number]): string {
  const entry = label.figures[figure];
  const unit = FIGURE_LABELS[figure].unit;
  const value = entry.display === null ? null : `${entry.display}${unit ? ` ${unit}` : ""}`;

  if (entry.complete) {
    return value!;
  }

  if (value === null) {
    return "No data";
  }

  return `At least ${value} (${entry.missing} ingredient${entry.missing === 1 ? "" : "s"} without data)`;
}

export function NutritionFacts({ label, caption }: { label: NutritionLabel; caption?: string }) {
  if (label.source === "NONE") {
    return <p className="text-sm text-neutral-700">No nutrition: this item has no recipe and no declared figures.</p>;
  }

  return (
    <div className="grid gap-2">
      <p className="text-sm">
        {label.complete ? <Badge tone="success">Complete</Badge> : <Badge tone="warning">Incomplete</Badge>}{" "}
        <span className="text-neutral-700">
          {caption ?? (label.source === "DECLARED" ? "Declared for this item." : "Calculated from the recipe, per portion.")}
        </span>
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        {NUTRITION_FIGURES.map((figure) => (
          <div key={figure} className="contents">
            <dt className="font-medium text-neutral-800">{FIGURE_LABELS[figure].name}</dt>
            <dd className="tabular">{figureText(label, figure)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
