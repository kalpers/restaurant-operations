import { and, eq, inArray, isNull } from "drizzle-orm";

import { locations, locationSettings, menuItemOutages, menuItemStockOverrides } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import { quantitiesOnHand } from "@/modules/inventory/queries/item-facts";
import { resolveCurrentRequirementsForMenuItems } from "@/modules/recipes/queries/menu-item-requirements";
import { NotFoundError } from "@/shared/errors/app-error";
import { businessDateOf, type BusinessDateSettings } from "@/shared/time/business-date-service";

import { portionsRemaining, sellabilityState, type SellabilityState } from "../rules/stock-signals";

// Phase 19: whether each menu item can be sold at one location right now (policies A3-A6).
// Outages and overrides are Menu records; stock comes from Inventory's public query and
// requirements from Recipes'. Nothing here is stored: auto-86 is worked out on every read.

export type LocationMenuSettings = BusinessDateSettings & { auto86FromStock: boolean };

export async function loadLocationMenuSettings(
  executor: DatabaseExecutor,
  organizationId: string,
  locationId: string,
): Promise<LocationMenuSettings> {
  const [row] = await executor
    .select({
      timeZone: locations.timezone,
      businessDayCutoff: locationSettings.businessDayCutoff,
      auto86FromStock: locationSettings.auto86FromStock,
    })
    .from(locations)
    .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
    .where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)));

  if (!row) {
    throw new NotFoundError("location");
  }

  return row;
}

export type ItemStockSignal = {
  menuItemId: string;
  state: SellabilityState;
  /** Null when the item has no recipe figure, or when it wasn't computed. */
  portions: number | null;
  limitingInventoryItemId: string | null;
  outage: { id: string; reason: string; markedOutAt: Date; markedOutByUserId: string; version: number } | null;
  override: { id: string; reason: string; setAt: Date; setByUserId: string; version: number } | null;
};

export type StockSignals = {
  businessDate: string;
  auto86FromStock: boolean;
  items: Map<string, ItemStockSignal>;
};

/**
 * Signals for the given items, treated as `available` (callers pass only available items, or
 * check `available` themselves). Portions are computed when `withPortions` is set, or when the
 * location has auto-86 on, because then they decide sellability.
 */
export async function loadStockSignals(
  executor: DatabaseExecutor,
  input: {
    organizationId: string;
    locationId: string;
    menuItemIds: readonly string[];
    at: Date;
    withPortions: boolean;
    availability?: ReadonlyMap<string, boolean>;
  },
): Promise<StockSignals> {
  const settings = await loadLocationMenuSettings(executor, input.organizationId, input.locationId);
  const businessDate = businessDateOf(input.at, settings);
  const items = new Map<string, ItemStockSignal>();

  if (input.menuItemIds.length === 0) {
    return { businessDate, auto86FromStock: settings.auto86FromStock, items };
  }

  const ids = [...input.menuItemIds];
  const outages = await executor
    .select()
    .from(menuItemOutages)
    .where(
      and(
        eq(menuItemOutages.locationId, input.locationId),
        eq(menuItemOutages.organizationId, input.organizationId),
        eq(menuItemOutages.status, "ACTIVE"),
        inArray(menuItemOutages.menuItemId, ids),
      ),
    );
  const overrides = await executor
    .select()
    .from(menuItemStockOverrides)
    .where(
      and(
        eq(menuItemStockOverrides.locationId, input.locationId),
        eq(menuItemStockOverrides.organizationId, input.organizationId),
        eq(menuItemStockOverrides.businessDate, businessDate),
        isNull(menuItemStockOverrides.clearedAt),
        inArray(menuItemStockOverrides.menuItemId, ids),
      ),
    );
  const computePortions = input.withPortions || settings.auto86FromStock;
  const requirements = computePortions
    ? await resolveCurrentRequirementsForMenuItems(executor, input.organizationId, ids, input.at)
    : new Map<string, null>();
  const inventoryItemIds = new Set<string>();

  for (const list of requirements.values()) {
    for (const requirement of list ?? []) {
      inventoryItemIds.add(requirement.inventoryItemId);
    }
  }

  const onHand = await quantitiesOnHand(executor, input.organizationId, input.locationId, [...inventoryItemIds]);

  for (const menuItemId of ids) {
    const outage = outages.find((row) => row.menuItemId === menuItemId) ?? null;
    const override = overrides.find((row) => row.menuItemId === menuItemId) ?? null;
    const portions = portionsRemaining(requirements.get(menuItemId) ?? null, onHand);
    const state = sellabilityState({
      available: input.availability?.get(menuItemId) ?? true,
      manuallyOut: outage !== null,
      autoEnabled: settings.auto86FromStock,
      portions: portions.portions,
      sellAnyway: override !== null,
    });

    items.set(menuItemId, {
      menuItemId,
      state,
      portions: portions.portions,
      limitingInventoryItemId: portions.limitingInventoryItemId,
      outage: outage && {
        id: outage.id,
        reason: outage.reason,
        markedOutAt: outage.markedOutAt,
        markedOutByUserId: outage.markedOutByUserId,
        version: outage.version,
      },
      override: override && {
        id: override.id,
        reason: override.reason,
        setAt: override.setAt,
        setByUserId: override.setByUserId,
        version: override.version,
      },
    });
  }

  return { businessDate, auto86FromStock: settings.auto86FromStock, items };
}
