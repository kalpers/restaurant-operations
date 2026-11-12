import { Badge } from "@/components/ui/badge";

export type LabelView = {
  allergens: { id: string; code: string; name: string; kind: "CONTAINS" | "MAY_CONTAIN" }[];
  incomplete: boolean;
};

/** An item's allergen label (Phase 21, policy 11). "Incomplete" is never shown as allergen free. */
export function AllergenLabelBadges({ label, compact = false }: { label: LabelView; compact?: boolean }) {
  const contains = label.allergens.filter((entry) => entry.kind === "CONTAINS");
  const mayContain = label.allergens.filter((entry) => entry.kind === "MAY_CONTAIN");

  if (label.allergens.length === 0 && !label.incomplete) {
    return compact ? null : <span className="text-sm text-neutral-600">No listed allergens</span>;
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {contains.map((entry) => (
        <Badge key={entry.id} tone="warning">
          {entry.name}
        </Badge>
      ))}
      {mayContain.map((entry) => (
        <Badge key={entry.id} tone="neutral">
          May contain {entry.name.toLowerCase()}
        </Badge>
      ))}
      {label.incomplete ? <Badge tone="danger">Allergens incomplete</Badge> : null}
    </span>
  );
}
