import { and, eq, gt, isNull, lte, or, type AnyColumn } from "drizzle-orm";

import {
  menuAvailability,
  menuItemPrepRouting,
  menuItemPrices,
  menuLocations,
  prepStations,
  taxRates,
} from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";

// Phase 23 (policy 2, D2): the Menu module's part of copying a location's setup. Each copy
// reads the source location and writes new rows for the new one inside the open-location
// transaction. Nothing at the source changes. Effective-dated rows (prices, tax rates) are
// copied as the rows in effect at `now`, starting at `now` with no end.

type CopyInput = {
  organizationId: string;
  fromLocationId: string;
  toLocationId: string;
  userId: string;
  now: Date;
};

const inEffect = (from: AnyColumn, to: AnyColumn, now: Date) =>
  and(lte(from, now), or(isNull(to), gt(to, now)));

/** D2 `STATIONS_AND_ROUTING`: active prep stations, then the item routes to them. */
export async function copyPrepStationsAndRouting(transaction: DatabaseTransaction, input: CopyInput): Promise<number> {
  const stations = await transaction
    .select()
    .from(prepStations)
    .where(and(eq(prepStations.locationId, input.fromLocationId), eq(prepStations.active, true)));
  const stationMap = new Map<string, string>();

  for (const station of stations) {
    const [created] = await transaction
      .insert(prepStations)
      .values({
        locationId: input.toLocationId,
        code: station.code,
        name: station.name,
        stationType: station.stationType,
        sortOrder: station.sortOrder,
      })
      .returning({ id: prepStations.id });

    stationMap.set(station.id, created!.id);
  }

  const routes = await transaction
    .select()
    .from(menuItemPrepRouting)
    .where(and(eq(menuItemPrepRouting.locationId, input.fromLocationId), eq(menuItemPrepRouting.active, true)));
  const copied = routes.filter((route) => stationMap.has(route.prepStationId));

  if (copied.length > 0) {
    await transaction.insert(menuItemPrepRouting).values(
      copied.map((route) => ({
        organizationId: input.organizationId,
        menuItemId: route.menuItemId,
        locationId: input.toLocationId,
        prepStationId: stationMap.get(route.prepStationId)!,
        sortOrder: route.sortOrder,
      })),
    );
  }

  return stations.length;
}

/** D2 `MENUS` (amendment 2): the menus offered at the source, with their time windows. */
export async function copyMenusOffered(transaction: DatabaseTransaction, input: CopyInput): Promise<number> {
  const offered = await transaction
    .select({ menuId: menuLocations.menuId })
    .from(menuLocations)
    .where(and(eq(menuLocations.locationId, input.fromLocationId), eq(menuLocations.active, true)));

  if (offered.length === 0) {
    return 0;
  }

  await transaction.insert(menuLocations).values(
    offered.map((row) => ({
      organizationId: input.organizationId,
      menuId: row.menuId,
      locationId: input.toLocationId,
    })),
  );

  for (const { menuId } of offered) {
    const windows = await transaction
      .select({ effectiveFrom: menuAvailability.effectiveFrom, effectiveTo: menuAvailability.effectiveTo })
      .from(menuAvailability)
      .where(
        and(
          eq(menuAvailability.menuId, menuId),
          eq(menuAvailability.locationId, input.fromLocationId),
          or(isNull(menuAvailability.effectiveTo), gt(menuAvailability.effectiveTo, input.now)),
        ),
      );

    if (windows.length > 0) {
      await transaction.insert(menuAvailability).values(
        windows.map((window) => ({
          menuId,
          locationId: input.toLocationId,
          // A window already under way starts now; later ones keep their times.
          effectiveFrom: window.effectiveFrom < input.now ? input.now : window.effectiveFrom,
          effectiveTo: window.effectiveTo,
          createdByUserId: input.userId,
        })),
      );
    }
  }

  return offered.length;
}

/** D2 `PRICES`: the source's own price rows in effect now. Organization defaults apply as before. */
export async function copyLocationPrices(transaction: DatabaseTransaction, input: CopyInput): Promise<number> {
  const prices = await transaction
    .select({ menuItemId: menuItemPrices.menuItemId, price: menuItemPrices.price })
    .from(menuItemPrices)
    .where(
      and(
        eq(menuItemPrices.locationId, input.fromLocationId),
        inEffect(menuItemPrices.effectiveFrom, menuItemPrices.effectiveTo, input.now),
      ),
    );

  if (prices.length > 0) {
    await transaction.insert(menuItemPrices).values(
      prices.map((row) => ({
        organizationId: input.organizationId,
        menuItemId: row.menuItemId,
        locationId: input.toLocationId,
        price: row.price,
        effectiveFrom: input.now,
        createdByUserId: input.userId,
      })),
    );
  }

  return prices.length;
}

/** D2 `TAX_RATES`: the source's tax rates in effect now (the tax switch is copied by Organization). */
export async function copyTaxRates(transaction: DatabaseTransaction, input: CopyInput): Promise<number> {
  const rates = await transaction
    .select({
      taxCategoryId: taxRates.taxCategoryId,
      ratePercent: taxRates.ratePercent,
      priceIncludesTax: taxRates.priceIncludesTax,
    })
    .from(taxRates)
    .where(
      and(
        eq(taxRates.locationId, input.fromLocationId),
        inEffect(taxRates.effectiveFrom, taxRates.effectiveTo, input.now),
      ),
    );

  if (rates.length > 0) {
    await transaction.insert(taxRates).values(
      rates.map((rate) => ({
        organizationId: input.organizationId,
        taxCategoryId: rate.taxCategoryId,
        locationId: input.toLocationId,
        ratePercent: rate.ratePercent,
        priceIncludesTax: rate.priceIncludesTax,
        effectiveFrom: input.now,
        createdByUserId: input.userId,
      })),
    );
  }

  return rates.length;
}
