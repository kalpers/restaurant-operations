import { and, eq, inArray } from "drizzle-orm";

import { locations, pricePeriodItems, pricePeriods } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

import { periodPriceAt, type PeriodPrice, type PricePeriodRule } from "../rules/price-periods";
import type { ResolvedPrice } from "../rules/price-resolution";

// Phase 28 (policies 3 and 5): the one place that reads price periods for selling. The
// operational menu (draft add, SEND, the order screen) and `resolveMenuItemPrice` both use it,
// so every caller resolves "happy hour" the same way.

export type PeriodPriceFacts = {
  timeZone: string;
  periods: PricePeriodRule[];
  /** menu item ID -> (period ID -> price). */
  prices: Map<string, Map<string, string>>;
};

export async function loadPeriodPriceFacts(
  executor: DatabaseExecutor,
  input: { organizationId: string; locationId: string; menuItemIds: readonly string[] },
): Promise<PeriodPriceFacts> {
  const [location] = await executor
    .select({ timeZone: locations.timezone })
    .from(locations)
    .where(and(eq(locations.id, input.locationId), eq(locations.organizationId, input.organizationId)));
  const facts: PeriodPriceFacts = {
    timeZone: location?.timeZone ?? "UTC",
    periods: [],
    prices: new Map(),
  };

  if (!location || input.menuItemIds.length === 0) {
    return facts;
  }

  const rows = await executor
    .select({ period: pricePeriods, item: pricePeriodItems })
    .from(pricePeriodItems)
    .innerJoin(pricePeriods, eq(pricePeriods.id, pricePeriodItems.pricePeriodId))
    .where(
      and(
        eq(pricePeriods.organizationId, input.organizationId),
        eq(pricePeriods.locationId, input.locationId),
        eq(pricePeriods.active, true),
        inArray(pricePeriodItems.menuItemId, [...new Set(input.menuItemIds)]),
      ),
    );
  const periods = new Map<string, PricePeriodRule>();

  for (const { period, item } of rows) {
    periods.set(period.id, {
      id: period.id,
      name: period.name,
      daysOfWeek: period.daysOfWeek,
      startTime: period.startTime,
      endTime: period.endTime,
      orderTypes: period.orderTypes,
      firstDate: period.firstDate,
      lastDate: period.lastDate,
      active: period.active,
    });

    const itemPrices = facts.prices.get(item.menuItemId) ?? new Map<string, string>();

    itemPrices.set(period.id, item.price);
    facts.prices.set(item.menuItemId, itemPrices);
  }

  facts.periods = [...periods.values()];

  return facts;
}

export type SellingPrice = ResolvedPrice & {
  /** The regular effective-dated price, the same as `price` outside a period. */
  regularPrice: string;
  pricePeriod: { id: string; name: string; endsAt: string } | null;
};

/**
 * Policy 3: the price an item sells at. No regular price in effect means not sellable, even
 * if a period would price it, so "no price" keeps meaning the same thing.
 */
export function sellingPrice(
  facts: PeriodPriceFacts,
  menuItemId: string,
  regular: ResolvedPrice | null,
  at: Date,
  orderType: string | null,
): SellingPrice | null {
  if (!regular) {
    return null;
  }

  const match: PeriodPrice | null = periodPriceAt(
    facts.periods,
    facts.prices.get(menuItemId) ?? new Map(),
    at,
    facts.timeZone,
    orderType,
  );

  if (!match) {
    return { ...regular, regularPrice: regular.price, pricePeriod: null };
  }

  return {
    price: match.price,
    scope: regular.scope,
    regularPrice: regular.price,
    pricePeriod: {
      id: match.period.id,
      name: match.period.name,
      endsAt: match.occurrence.endsAt.toISOString(),
    },
  };
}
