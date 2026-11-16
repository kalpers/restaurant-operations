import {
  applyModifierEffects,
  type BaseEffect,
  type Requirement,
} from "@/modules/recipes/rules/modifier-recipe-effects";
import {
  addDecimals,
  compareDecimals,
  divideRoundHalfUp,
  multiplyExact,
  roundHalfUp,
  subtractDecimals,
  wholeQuotientCeiling,
} from "@/shared/decimal/decimal";
import { weightedAverage, weightedAverageDecimal } from "@/shared/forecasting/history-dates";

// Phase 25 item and ingredient forecast rules (policies 3, 6-8 and the prep rounding of
// policy 9). Pure and deterministic, decimal strings only. They sit with the workflow because
// they use the Recipes modifier rule, which `src/shared` may not import.

export type ItemForecastStatus = "OK" | "NOT_ENOUGH_HISTORY";

export type ModifierShare = { modifierId: string; share: string };

export type ItemForecast = {
  menuItemId: string;
  /** Weighted same-weekday average portions, two places; null without enough history. */
  portions: string | null;
  /** The item's first sale is after the oldest sample date (or it has never sold). */
  newItem: boolean;
  /** Share of the item's portions that carried each modifier, four places. */
  modifierShares: ModifierShare[];
};

/** Portions per business date and menu item. */
export type PortionHistory = ReadonlyMap<string, ReadonlyMap<string, number>>;
/** Portions per business date, menu item and modifier. */
export type ModifierHistory = ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, number>>>;

/**
 * Policies 3 and 6: one target date's forecast for each item. A usable date on which an item
 * didn't sell counts as zero. Modifier shares skip the dates the item didn't sell.
 */
export function forecastItems(input: {
  sampleDates: readonly string[];
  minimumSamples: number;
  menuItemIds: readonly string[];
  portions: PortionHistory;
  modifiers: ModifierHistory;
  firstSaleDates: ReadonlyMap<string, string>;
}): { status: ItemForecastStatus; items: ItemForecast[] } {
  const enough = input.sampleDates.length >= input.minimumSamples && input.sampleDates.length > 0;
  const oldest = input.sampleDates[input.sampleDates.length - 1];

  return {
    status: enough ? "OK" : "NOT_ENOUGH_HISTORY",
    items: input.menuItemIds.map((menuItemId) => {
      const firstSale = input.firstSaleDates.get(menuItemId);
      const newItem = firstSale === undefined || (oldest !== undefined && firstSale > oldest);

      if (!enough) {
        return { menuItemId, portions: null, newItem, modifierShares: [] };
      }

      const counts = input.sampleDates.map((date) => input.portions.get(date)?.get(menuItemId) ?? 0);
      const soldDates = input.sampleDates.filter((date) => (input.portions.get(date)?.get(menuItemId) ?? 0) > 0);
      const modifierIds = new Set<string>();

      for (const date of soldDates) {
        for (const modifierId of input.modifiers.get(date)?.get(menuItemId)?.keys() ?? []) {
          modifierIds.add(modifierId);
        }
      }

      const modifierShares = [...modifierIds].sort().map((modifierId) => ({
        modifierId,
        share: weightedAverageDecimal(
          soldDates.map((date) =>
            divideRoundHalfUp(
              String(input.modifiers.get(date)?.get(menuItemId)?.get(modifierId) ?? 0),
              String(input.portions.get(date)!.get(menuItemId)!),
              6,
            ),
          ),
          4,
        ),
      }));

      return { menuItemId, portions: weightedAverage(counts), newItem, modifierShares };
    }),
  };
}

/** Policy 8: today's remaining portions, the forecast less what has been sent, never below zero. */
export function remainingPortions(portions: string, sentToday: number): string {
  const remaining = subtractDecimals(portions, String(sentToday));

  return compareDecimals(remaining, "0") > 0 ? roundHalfUp(remaining, 2) : "0.00";
}

/**
 * Policy 7: what one portion takes on average: the recipe's requirements plus, per modifier,
 * its share × the change it makes on its own (worked out with the SEND rule,
 * `applyModifierEffects`). Modifiers are taken one at a time; interactions are ignored.
 * Never below zero per ingredient.
 */
export function averagePortionRequirements(input: {
  requirements: readonly Requirement[];
  effects: readonly (BaseEffect & { modifierId: string })[];
  shares: readonly ModifierShare[];
}): Requirement[] {
  const base = new Map(input.requirements.map((entry) => [entry.inventoryItemId, entry.baseQuantity]));
  const totals = new Map(base);

  for (const { modifierId, share } of input.shares) {
    const effects = input.effects.filter((effect) => effect.modifierId === modifierId);

    if (effects.length === 0 || compareDecimals(share, "0") === 0) {
      continue;
    }

    const changed = new Map(
      applyModifierEffects(input.requirements, effects).map((entry) => [entry.inventoryItemId, entry.baseQuantity]),
    );

    for (const inventoryItemId of new Set([...base.keys(), ...changed.keys()])) {
      const delta = subtractDecimals(changed.get(inventoryItemId) ?? "0", base.get(inventoryItemId) ?? "0");

      if (compareDecimals(delta, "0") !== 0) {
        totals.set(inventoryItemId, addDecimals(totals.get(inventoryItemId) ?? "0", multiplyExact(share, delta)));
      }
    }
  }

  return [...totals.entries()]
    .filter(([, quantity]) => compareDecimals(quantity, "0") > 0)
    .map(([inventoryItemId, baseQuantity]) => ({ inventoryItemId, baseQuantity }))
    .sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId));
}

/** Policy 7: portions × the average portion, four places. */
export function usageFor(portions: string, perPortion: readonly Requirement[]): Requirement[] {
  return perPortion
    .map((entry) => ({
      inventoryItemId: entry.inventoryItemId,
      baseQuantity: roundHalfUp(multiplyExact(portions, entry.baseQuantity), 4),
    }))
    .filter((entry) => compareDecimals(entry.baseQuantity, "0") > 0);
}

/** Adds requirement lists by inventory item, sorted by item ID. */
export function sumRequirements(lists: readonly (readonly Requirement[])[]): Requirement[] {
  const totals = new Map<string, string>();

  for (const list of lists) {
    for (const entry of list) {
      totals.set(entry.inventoryItemId, addDecimals(totals.get(entry.inventoryItemId) ?? "0", entry.baseQuantity));
    }
  }

  return [...totals.entries()]
    .map(([inventoryItemId, baseQuantity]) => ({ inventoryItemId, baseQuantity: roundHalfUp(baseQuantity, 4) }))
    .sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId));
}

/** Policy 9: whole portions to prep, rounded up. */
export function prepPortions(portions: string): number {
  return Number(wholeQuotientCeiling(portions, "1"));
}

/** Policy 9: about how many of the prepped portions carry a modifier, rounded half up. */
export function modifierCount(portions: number, share: string): number {
  return Number(roundHalfUp(multiplyExact(String(portions), share), 0));
}
