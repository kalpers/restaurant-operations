import { addDecimals, compareDecimals, multiplyExact } from "@/shared/decimal/decimal";

// Phase 19 policy 21, approved amendment 7: menu engineering across the whole menu (order items
// carry no category snapshot). An item is popular when its count is at least 70% of an even
// share of all items sold (the Kasavana-Smith rule), and high-margin when its contribution
// margin per item is at least the weighted average. Comparisons are exact cross-multiplications.

export type EngineeringInput = {
  key: string;
  quantity: number;
  /** Total contribution margin (net item sales minus theoretical cost), or null with no cost. */
  marginTotal: string | null;
};

export type EngineeringClass = "STAR" | "PLOWHORSE" | "PUZZLE" | "DOG" | "NO_COST";

export const ENGINEERING_LABEL: Record<EngineeringClass, string> = {
  STAR: "Star",
  PLOWHORSE: "Plowhorse",
  PUZZLE: "Puzzle",
  DOG: "Dog",
  NO_COST: "No cost",
};

export function classifyMenuItems(items: readonly EngineeringInput[]): Map<string, EngineeringClass> {
  const result = new Map<string, EngineeringClass>();
  const costed = items.filter((item) => item.marginTotal !== null && item.quantity > 0);

  for (const item of items) {
    if (!costed.includes(item)) {
      result.set(item.key, "NO_COST");
    }
  }

  if (costed.length === 0) {
    return result;
  }

  const count = costed.length;
  const totalQuantity = costed.reduce((sum, item) => sum + item.quantity, 0);
  const totalMargin = costed.reduce((sum, item) => addDecimals(sum, item.marginTotal!), "0");

  for (const item of costed) {
    // quantity >= 0.7 * totalQuantity / count  <=>  10 * quantity * count >= 7 * totalQuantity
    const popular = 10 * item.quantity * count >= 7 * totalQuantity;
    // margin / quantity >= totalMargin / totalQuantity  <=>  margin * totalQuantity >= totalMargin * quantity
    const profitable =
      compareDecimals(
        multiplyExact(item.marginTotal!, String(totalQuantity)),
        multiplyExact(totalMargin, String(item.quantity)),
      ) >= 0;

    result.set(item.key, popular ? (profitable ? "STAR" : "PLOWHORSE") : profitable ? "PUZZLE" : "DOG");
  }

  return result;
}
