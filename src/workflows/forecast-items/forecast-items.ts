import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { findInventoryItemLabels } from "@/modules/inventory/queries/item-facts";
import { viewableStationTypes } from "@/modules/kitchen/services/access";
import {
  getForecastMenu,
  getForecastModifierEffects,
  getModifierNames,
  type ForecastMenuItem,
  type ForecastModifierEffect,
  type ForecastStation,
} from "@/modules/menu/queries/forecast-menu";
import { getItemSalesHistory, getPortionsSentOn } from "@/modules/orders/queries/item-sales-history";
import { resolveRevisionRequirementsForMenuItems } from "@/modules/recipes/queries/menu-item-requirements";
import type { Requirement } from "@/modules/recipes/rules/modifier-recipe-effects";
import { readForecastInputs } from "@/modules/scheduling/queries/forecast-inputs";
import { compareDecimals } from "@/shared/decimal/decimal";
import { AuthorizationError, NotFoundError, ValidationError } from "@/shared/errors/app-error";
import { MAXIMUM_HISTORY_WEEKS, selectHistoryDates } from "@/shared/forecasting/history-dates";
import { businessDateOf, businessDateStart, type BusinessDateSettings } from "@/shared/time/business-date-service";
import { addDays } from "@/shared/time/zoned-time";

import {
  averagePortionRequirements,
  forecastItems,
  modifierCount,
  prepPortions,
  remainingPortions,
  sumRequirements,
  usageFor,
  type ItemForecastStatus,
  type ModifierShare,
} from "./item-forecast-rules";

// Phase 25 item forecast workflow (D9). It reads closed-check history (Orders), the menu and
// station routing (Menu), recipes in effect (Recipes) and the forecast settings (Scheduling),
// and works out portions per item and date, what they take, prep lists and the usage that the
// Inventory purchasing suggestion receives. Read-only: it writes nothing and moves no stock.

/** How far ahead the item forecast reaches (D5, D6). */
export const MAXIMUM_DAYS_AHEAD = 14;

export type ForecastItemDay = {
  menuItemId: string;
  code: string;
  name: string;
  stationIds: string[];
  /** The whole-day forecast, two places; null without enough history. */
  forecastPortions: string | null;
  /** For today, portions already sent; else 0. */
  sentToday: number;
  /** The portions still to come: the forecast, less what was sent for today (policy 8). */
  portions: string | null;
  newItem: boolean;
  /** Null: no recipe revision in effect (`NO_RECIPE`). */
  recipeVersionId: string | null;
  modifierShares: ModifierShare[];
  /** What one portion takes on average (policy 7). */
  perPortion: Requirement[];
  /** `portions` × `perPortion`; empty without a forecast. */
  usage: Requirement[];
};

export type ForecastDay = {
  businessDate: string;
  status: ItemForecastStatus;
  sampleDates: string[];
  items: ForecastItemDay[];
};

export type ItemForecastResult = {
  clock: BusinessDateSettings;
  today: string;
  settings: { lookbackWeeks: number; minimumSamples: number };
  excludedDates: string[];
  stations: ForecastStation[];
  days: ForecastDay[];
};

/** Policies 3-8: the item and ingredient forecast for each business date in the range. */
export async function buildItemForecast(
  executor: DatabaseExecutor,
  input: { organizationId: string; locationId: string; fromDate: string; toDate: string; now?: Date },
): Promise<ItemForecastResult> {
  const now = input.now ?? new Date();
  const { clock, settings, excludedDates } = await readForecastInputs(executor, input.locationId);
  const today = businessDateOf(now, clock);

  if (input.fromDate < today || input.toDate < input.fromDate || input.toDate > addDays(today, MAXIMUM_DAYS_AHEAD)) {
    throw new ValidationError(`Forecast dates run from today to ${MAXIMUM_DAYS_AHEAD} days ahead.`);
  }

  const dates: string[] = [];

  for (let date = input.fromDate; date <= input.toDate; date = addDays(date, 1)) {
    dates.push(date);
  }

  const historyTo = addDays(today, -1);
  const history = await getItemSalesHistory(executor, {
    locationId: input.locationId,
    fromDate: addDays(input.fromDate, -7 * MAXIMUM_HISTORY_WEEKS),
    toDate: historyTo,
  });
  const portions = new Map<string, Map<string, number>>();

  for (const row of history.items) {
    const byItem = portions.get(row.businessDate) ?? new Map<string, number>();

    byItem.set(row.menuItemId, row.portions);
    portions.set(row.businessDate, byItem);
  }

  const modifierHistory = new Map<string, Map<string, Map<string, number>>>();

  for (const row of history.modifiers) {
    const byItem = modifierHistory.get(row.businessDate) ?? new Map<string, Map<string, number>>();
    const byModifier = byItem.get(row.menuItemId) ?? new Map<string, number>();

    byModifier.set(row.modifierId, row.portions);
    byItem.set(row.menuItemId, byModifier);
    modifierHistory.set(row.businessDate, byItem);
  }

  const openDates = new Set(history.openDates);
  const excluded = new Set(excludedDates);
  const sentToday = dates.includes(today)
    ? await getPortionsSentOn(executor, { locationId: input.locationId, businessDate: today })
    : new Map<string, number>();
  let stations: ForecastStation[] = [];
  const menus = new Map<string, ForecastMenuItem[]>();

  for (const date of dates) {
    const menu = await getForecastMenu(executor, {
      organizationId: input.organizationId,
      locationId: input.locationId,
      from: businessDateStart(date, clock),
      to: businessDateStart(addDays(date, 1), clock),
    });

    stations = menu.stations;
    menus.set(date, menu.items);
  }

  const allItemIds = [...new Set([...menus.values()].flat().map((item) => item.menuItemId))];
  const effects = await getForecastModifierEffects(executor, {
    organizationId: input.organizationId,
    menuItemIds: allItemIds,
  });
  const effectsByItem = new Map<string, ForecastModifierEffect[]>();

  for (const effect of effects) {
    const list = effectsByItem.get(effect.menuItemId) ?? [];

    list.push(effect);
    effectsByItem.set(effect.menuItemId, list);
  }

  const days: ForecastDay[] = [];

  for (const date of dates) {
    const menu = menus.get(date)!;
    const sampleDates = selectHistoryDates({
      targetDate: date,
      today,
      openDates,
      excludedDates: excluded,
      lookbackWeeks: settings.lookbackWeeks,
    });
    const forecast = forecastItems({
      sampleDates,
      minimumSamples: settings.minimumSamples,
      menuItemIds: menu.map((item) => item.menuItemId),
      portions,
      modifiers: modifierHistory,
      firstSaleDates: history.firstSaleDates,
    });
    const revisions = await resolveRevisionRequirementsForMenuItems(
      executor,
      input.organizationId,
      menu.map((item) => item.menuItemId),
      businessDateStart(date, clock),
    );

    days.push({
      businessDate: date,
      status: forecast.status,
      sampleDates,
      items: menu.map((item, index) => {
        const itemForecast = forecast.items[index]!;
        const revision = revisions.get(item.menuItemId) ?? null;
        const sent = date === today ? (sentToday.get(item.menuItemId) ?? 0) : 0;
        const remaining =
          itemForecast.portions === null ? null : date === today ? remainingPortions(itemForecast.portions, sent) : itemForecast.portions;
        const perPortion = averagePortionRequirements({
          requirements: revision?.requirements ?? [],
          effects: effectsByItem.get(item.menuItemId) ?? [],
          shares: itemForecast.modifierShares,
        });

        return {
          ...item,
          forecastPortions: itemForecast.portions,
          sentToday: sent,
          portions: remaining,
          newItem: itemForecast.newItem,
          recipeVersionId: revision?.recipeVersionId ?? null,
          modifierShares: itemForecast.modifierShares,
          perPortion,
          usage: remaining === null ? [] : usageFor(remaining, perPortion),
        };
      }),
    });
  }

  return { clock, today, settings, excludedDates, stations, days };
}

export type PrepList = {
  businessDate: string;
  today: string;
  status: ItemForecastStatus;
  sampleDates: string[];
  stations: {
    id: string;
    code: string;
    name: string;
    stationType: "KITCHEN" | "BAR";
    items: {
      menuItemId: string;
      code: string;
      name: string;
      /** Whole portions to prep, rounded up; null without enough history. */
      portions: number | null;
      forecastPortions: string | null;
      sentToday: number;
      newItem: boolean;
      noRecipe: boolean;
      modifiers: { modifierId: string; name: string; count: number }[];
      ingredients: { inventoryItemId: string; code: string; name: string; baseQuantity: string; unitCode: string }[];
    }[];
  }[];
};

/**
 * Policies 9-10 (D5): the prep list per KITCHEN or BAR station the actor may view, for one
 * business date from today to 6 days ahead. Stores nothing.
 */
export async function getPrepList(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { businessDate?: string; stationId?: string; now?: Date },
): Promise<PrepList> {
  const types = viewableStationTypes(actor);

  if (types.length === 0) {
    throw new AuthorizationError();
  }

  const now = input.now ?? new Date();
  const { clock } = await readForecastInputs(executor, actor.locationId);
  const today = businessDateOf(now, clock);
  const businessDate = input.businessDate ?? today;

  if (businessDate < today || businessDate > addDays(today, 6)) {
    throw new ValidationError("Prep lists cover today and the next 6 days.");
  }

  const forecast = await buildItemForecast(executor, {
    organizationId: actor.organizationId,
    locationId: actor.locationId,
    fromDate: businessDate,
    toDate: businessDate,
    now,
  });
  const day = forecast.days[0]!;
  const stations = forecast.stations.filter(
    (station): station is ForecastStation & { stationType: "KITCHEN" | "BAR" } =>
      (station.stationType === "KITCHEN" || station.stationType === "BAR") &&
      types.includes(station.stationType) &&
      (input.stationId === undefined || station.id === input.stationId),
  );

  if (input.stationId !== undefined && stations.length === 0) {
    throw new NotFoundError("prep station");
  }

  const prepped = day.items.map((item) => {
    const whole = item.portions === null ? null : prepPortions(item.portions);

    return {
      item,
      whole,
      ingredients: whole === null || whole === 0 ? [] : usageFor(String(whole), item.perPortion),
    };
  });
  const [labels, modifierNames] = await Promise.all([
    findInventoryItemLabels(
      executor,
      actor.organizationId,
      prepped.flatMap((entry) => entry.ingredients.map((ingredient) => ingredient.inventoryItemId)),
    ),
    getModifierNames(
      executor,
      day.items.flatMap((item) => item.modifierShares.map((share) => share.modifierId)),
    ),
  ]);

  return {
    businessDate,
    today,
    status: day.status,
    sampleDates: day.sampleDates,
    stations: stations.map((station) => ({
      id: station.id,
      code: station.code,
      name: station.name,
      stationType: station.stationType,
      items: prepped
        .filter(({ item }) => item.stationIds.includes(station.id))
        .map(({ item, whole, ingredients }) => ({
          menuItemId: item.menuItemId,
          code: item.code,
          name: item.name,
          portions: whole,
          forecastPortions: item.forecastPortions,
          sentToday: item.sentToday,
          newItem: item.newItem,
          noRecipe: item.recipeVersionId === null,
          modifiers:
            whole === null
              ? []
              : item.modifierShares
                  .map((share) => ({
                    modifierId: share.modifierId,
                    name: modifierNames.get(share.modifierId) ?? "Modifier",
                    count: modifierCount(whole, share.share),
                  }))
                  .filter((entry) => entry.count >= 1),
          ingredients: ingredients
            .map((ingredient) => {
              const label = labels.get(ingredient.inventoryItemId)!;

              return { ...ingredient, code: label.code, name: label.name, unitCode: label.baseUnitCode };
            })
            .sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => (b.portions ?? -1) - (a.portions ?? -1) || a.name.localeCompare(b.name)),
    })),
  };
}

export type ForecastUsage = {
  fromDate: string;
  throughDate: string;
  /** Base units per inventory item that the forecast uses, today's remainder through the date. */
  usage: Map<string, string>;
  dates: { businessDate: string; status: ItemForecastStatus; sampleDates: string[] }[];
  /** For the stored snapshot (policy 14). */
  items: {
    businessDate: string;
    menuItemId: string;
    status: ItemForecastStatus;
    portions: string | null;
    newItem: boolean;
    recipeVersionId: string | null;
  }[];
  method: Record<string, unknown>;
};

/**
 * Policies 11 and 13 (D6): forecast usage per inventory item from today's business date
 * through the chosen date (tomorrow to 14 days ahead), with the item forecast behind it.
 */
export async function computeForecastUsage(
  executor: DatabaseExecutor,
  input: { organizationId: string; locationId: string; throughDate: string; now?: Date },
): Promise<ForecastUsage> {
  const now = input.now ?? new Date();
  const { clock } = await readForecastInputs(executor, input.locationId);
  const today = businessDateOf(now, clock);

  if (input.throughDate <= today || input.throughDate > addDays(today, MAXIMUM_DAYS_AHEAD)) {
    throw new ValidationError(`Choose a date from tomorrow to ${MAXIMUM_DAYS_AHEAD} days ahead.`);
  }

  const forecast = await buildItemForecast(executor, {
    organizationId: input.organizationId,
    locationId: input.locationId,
    fromDate: today,
    toDate: input.throughDate,
    now,
  });
  const usage = new Map(
    sumRequirements(forecast.days.flatMap((day) => day.items.map((item) => item.usage)))
      .filter((entry) => compareDecimals(entry.baseQuantity, "0") > 0)
      .map((entry) => [entry.inventoryItemId, entry.baseQuantity]),
  );

  return {
    fromDate: today,
    throughDate: input.throughDate,
    usage,
    dates: forecast.days.map((day) => ({ businessDate: day.businessDate, status: day.status, sampleDates: day.sampleDates })),
    items: forecast.days.flatMap((day) =>
      day.items.map((item) => ({
        businessDate: day.businessDate,
        menuItemId: item.menuItemId,
        status: day.status,
        portions: item.forecastPortions,
        newItem: item.newItem,
        recipeVersionId: item.recipeVersionId,
      })),
    ),
    method: {
      lookbackWeeks: forecast.settings.lookbackWeeks,
      minimumSamples: forecast.settings.minimumSamples,
      excludedDates: forecast.excludedDates,
      sampleDates: Object.fromEntries(forecast.days.map((day) => [day.businessDate, day.sampleDates])),
      sentToday: Object.fromEntries(
        (forecast.days.find((day) => day.businessDate === today)?.items ?? [])
          .filter((item) => item.sentToday > 0)
          .map((item) => [item.menuItemId, item.sentToday]),
      ),
      modifierShares: Object.fromEntries(
        forecast.days.map((day) => [
          day.businessDate,
          Object.fromEntries(
            day.items
              .filter((item) => item.modifierShares.length > 0)
              .map((item) => [item.menuItemId, item.modifierShares]),
          ),
        ]),
      ),
    },
  };
}
