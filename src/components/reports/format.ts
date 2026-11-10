import { formatMoney } from "@/components/format/money";
import type { ColumnKind, ReportCell } from "@/modules/reporting/types";

function trimQuantity(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") || "0" : value;
}

/**
 * Display text for a report cell. Money stays a decimal string and only gains a symbol;
 * it is never turned into a JavaScript number.
 */
export function formatCell(kind: ColumnKind, value: ReportCell): string {
  if (value === null || value === undefined) {
    return "—";
  }

  const text = String(value);

  switch (kind) {
    case "money":
      return formatMoney(text);
    case "cost":
      return text.startsWith("-") ? `-$${trimCost(text.slice(1))}` : `$${trimCost(text)}`;
    case "quantity":
      return trimQuantity(text);
    case "hours":
      return trimQuantity(text);
    case "percent":
      return `${text}%`;
    case "minutes":
      return `${text} min`;
    default:
      return text;
  }
}

/** Costs are 4 places; show at least cents. */
function trimCost(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");

  return `${whole}.${trimmed.padEnd(2, "0")}`;
}

export function isNumericKind(kind: ColumnKind): boolean {
  return kind !== "text" && kind !== "date";
}
