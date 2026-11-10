import { formatMoneyChange } from "@/components/format/money";
import type { DashboardTile } from "@/modules/reporting/services/report-service";
import { compareDecimals, isDecimalString, subtractDecimals } from "@/shared/decimal/decimal";

export type TileDelta = { text: string; direction: "up" | "down" | "same" };

/**
 * The change of one dashboard figure against the previous business date. Display only:
 * both values come from the reporting service, and decimal strings are subtracted as exact
 * decimals, never as JavaScript numbers. Values that can't be compared give no delta.
 */
export function tileDelta(kind: DashboardTile["kind"], current: DashboardTile["value"], previous: DashboardTile["value"] | undefined): TileDelta | null {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return null;
  }

  let change: string;

  if (typeof current === "number" && typeof previous === "number") {
    change = String(current - previous);
  } else if (isDecimalString(String(current)) && isDecimalString(String(previous))) {
    change = subtractDecimals(String(current), String(previous));
  } else {
    return null;
  }

  const sign = isDecimalString(change) ? compareDecimals(change, "0") : 0;
  const direction = sign > 0 ? "up" : sign < 0 ? "down" : "same";
  const magnitude = change.startsWith("-") ? change.slice(1) : change;

  if (kind === "money" || kind === "cost") {
    return { text: formatMoneyChange(change), direction };
  }

  const signed = direction === "up" ? `+${magnitude}` : direction === "down" ? `-${magnitude}` : magnitude;
  const unit = kind === "percent" ? " pts" : kind === "minutes" ? " min" : kind === "hours" ? " h" : "";

  return { text: `${signed}${unit}`, direction };
}
