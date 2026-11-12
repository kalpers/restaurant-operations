import { and, asc, eq, gt, gte, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { isExclusionViolation, isUniqueViolation } from "@/db/helpers/database-errors";
import {
  locationSettings,
  menuItemOutages,
  menuItemPlacements,
  menuItems,
  menuItemStockOverrides,
  menuLocations,
  menus,
  modifierOutages,
  modifiers,
} from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { findInventoryItemNames } from "@/modules/inventory/queries/item-facts";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { businessDateStart } from "@/shared/time/business-date-service";

import { loadLocationMenuSettings, loadStockSignals } from "../queries/stock-signals";
import { outagePhase, resolveOutageWindow, type OutageWindowInput } from "../rules/outage-window";
import { isRunningLow, type SellabilityState } from "../rules/stock-signals";
import { actorHolds, assertPermission } from "./access";

// Phase 19 per-location 86 board (approved policies A2, A4, A5, A7-A9). Each change is one
// transaction with its audit row and a `menu.availability-changed` outbox event, so order
// screens and the board refetch only after it commits. Nothing here touches stock.

export const AVAILABILITY_CHANGED_EVENT = "menu.availability-changed";

const MAX_REASON = 200;

function cleanReason(reason: string): string {
  const trimmed = reason.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_REASON) {
    throw new BusinessRuleError("INVALID_REASON", `Give a reason of 1 to ${MAX_REASON} characters.`);
  }

  return trimmed;
}

async function requireActiveItem(executor: DatabaseExecutor, actor: Actor, menuItemId: string) {
  const [item] = await executor
    .select({ id: menuItems.id, code: menuItems.code, active: menuItems.active })
    .from(menuItems)
    .where(and(eq(menuItems.id, menuItemId), eq(menuItems.organizationId, actor.organizationId)));

  if (!item) {
    throw new NotFoundError("menu item");
  }

  if (!item.active) {
    throw new BusinessRuleError("ITEM_INACTIVE", "That item isn't on the menu.");
  }

  return item;
}

async function announce(transaction: DatabaseTransaction, actor: Actor, menuItemId: string, change: string, now: Date) {
  await writeOutboxEvents(transaction, [
    {
      organizationId: actor.organizationId,
      locationId: actor.locationId,
      eventType: AVAILABILITY_CHANGED_EVENT,
      aggregateType: "menu_item",
      aggregateId: menuItemId,
      payload: { menuItemId, change },
      occurredAt: now,
    },
  ]);
}

// ------------------------------------------------------------------ manual 86

/** Phase 20 (policy 4): the window, from the location's business-date settings. */
async function windowFor(executor: DatabaseExecutor, actor: Actor, input: OutageWindowInput, now: Date) {
  const settings = await loadLocationMenuSettings(executor, actor.organizationId, actor.locationId);

  return resolveOutageWindow(input, now, settings);
}

function windowDetails(window: { startsAt: Date; endsAt: Date | null }, now: Date) {
  return {
    ...(window.startsAt.getTime() > now.getTime() ? { startsAt: window.startsAt.toISOString() } : {}),
    ...(window.endsAt ? { endsAt: window.endsAt.toISOString() } : {}),
  };
}

export async function markItemOut(
  database: Database,
  actor: Actor,
  input: { menuItemId: string; reason: string } & OutageWindowInput,
) {
  assertPermission(actor, "menu.availability.manage");

  const reason = cleanReason(input.reason);

  try {
    return await withTransaction(database, async (transaction) => {
      const item = await requireActiveItem(transaction, actor, input.menuItemId);
      const now = new Date();
      const window = await windowFor(transaction, actor, input, now);
      const [row] = await transaction
        .insert(menuItemOutages)
        .values({
          organizationId: actor.organizationId,
          locationId: actor.locationId,
          menuItemId: item.id,
          reason,
          markedOutAt: now,
          markedOutByUserId: actor.userId,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
        })
        .returning();

      await recordAudit(transaction, actor, {
        action: "menu.item-marked-out",
        entityId: item.id,
        details: { itemCode: item.code, outageId: row!.id, reason, ...windowDetails(window, now) },
      });
      await announce(transaction, actor, item.id, "MARKED_OUT", now);

      return row!;
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new ConflictError("ITEM_ALREADY_86ED", "That item is already 86'd here for some of that time.");
    }

    throw error;
  }
}

export async function restoreItem(
  database: Database,
  actor: Actor,
  input: { outageId: string; expectedVersion: number },
) {
  assertPermission(actor, "menu.availability.manage");

  return withTransaction(database, async (transaction) => {
    const [current] = await transaction
      .select({ outage: menuItemOutages, itemCode: menuItems.code })
      .from(menuItemOutages)
      .innerJoin(menuItems, eq(menuItems.id, menuItemOutages.menuItemId))
      .where(
        and(
          eq(menuItemOutages.id, input.outageId),
          eq(menuItemOutages.organizationId, actor.organizationId),
          eq(menuItemOutages.locationId, actor.locationId),
        ),
      )
      .for("update", { of: menuItemOutages });

    if (!current) {
      throw new NotFoundError("86 record");
    }

    if (current.outage.status !== "ACTIVE") {
      throw new BusinessRuleError("ITEM_NOT_86ED", "That item has already been restored.");
    }

    if (current.outage.version !== input.expectedVersion) {
      throw new ConcurrencyError("86 record", input.outageId);
    }

    const now = new Date();
    const [row] = await transaction
      .update(menuItemOutages)
      .set({
        status: "RESTORED",
        restoredAt: now,
        restoredByUserId: actor.userId,
        updatedAt: now,
        version: sql`${menuItemOutages.version} + 1`,
      })
      .where(eq(menuItemOutages.id, input.outageId))
      .returning();

    await recordAudit(transaction, actor, {
      action: "menu.item-restored",
      entityId: current.outage.menuItemId,
      details: { itemCode: current.itemCode, outageId: input.outageId },
    });
    await announce(transaction, actor, current.outage.menuItemId, "RESTORED", now);

    return row!;
  });
}

// ------------------------------------------------------------------ modifier 86 (Phase 20)

async function requireActiveModifier(executor: DatabaseExecutor, actor: Actor, modifierId: string) {
  const [modifier] = await executor
    .select({ id: modifiers.id, code: modifiers.code, active: modifiers.active })
    .from(modifiers)
    .where(and(eq(modifiers.id, modifierId), eq(modifiers.organizationId, actor.organizationId)));

  if (!modifier) {
    throw new NotFoundError("modifier");
  }

  if (!modifier.active) {
    throw new BusinessRuleError("MODIFIER_INACTIVE", "That modifier isn't active.");
  }

  return modifier;
}

async function announceModifier(transaction: DatabaseTransaction, actor: Actor, modifierId: string, change: string, now: Date) {
  await writeOutboxEvents(transaction, [
    {
      organizationId: actor.organizationId,
      locationId: actor.locationId,
      eventType: AVAILABILITY_CHANGED_EVENT,
      aggregateType: "modifier",
      aggregateId: modifierId,
      payload: { modifierId, change },
      occurredAt: now,
    },
  ]);
}

/** Policy 3: 86 a modifier at the actor's location, now or on a schedule. */
export async function markModifierOut(
  database: Database,
  actor: Actor,
  input: { modifierId: string; reason: string } & OutageWindowInput,
) {
  assertPermission(actor, "menu.availability.manage");

  const reason = cleanReason(input.reason);

  try {
    return await withTransaction(database, async (transaction) => {
      const modifier = await requireActiveModifier(transaction, actor, input.modifierId);
      const now = new Date();
      const window = await windowFor(transaction, actor, input, now);
      const [row] = await transaction
        .insert(modifierOutages)
        .values({
          organizationId: actor.organizationId,
          locationId: actor.locationId,
          modifierId: modifier.id,
          reason,
          markedOutAt: now,
          markedOutByUserId: actor.userId,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
        })
        .returning();

      await recordAudit(transaction, actor, {
        action: "menu.modifier-marked-out",
        entityId: modifier.id,
        details: { modifierCode: modifier.code, outageId: row!.id, reason, ...windowDetails(window, now) },
      });
      await announceModifier(transaction, actor, modifier.id, "MARKED_OUT", now);

      return row!;
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new ConflictError("MODIFIER_ALREADY_86ED", "That modifier is already 86'd here for some of that time.");
    }

    throw error;
  }
}

export async function restoreModifier(
  database: Database,
  actor: Actor,
  input: { outageId: string; expectedVersion: number },
) {
  assertPermission(actor, "menu.availability.manage");

  return withTransaction(database, async (transaction) => {
    const [current] = await transaction
      .select({ outage: modifierOutages, modifierCode: modifiers.code })
      .from(modifierOutages)
      .innerJoin(modifiers, eq(modifiers.id, modifierOutages.modifierId))
      .where(
        and(
          eq(modifierOutages.id, input.outageId),
          eq(modifierOutages.organizationId, actor.organizationId),
          eq(modifierOutages.locationId, actor.locationId),
        ),
      )
      .for("update", { of: modifierOutages });

    if (!current) {
      throw new NotFoundError("modifier 86 record");
    }

    if (current.outage.status !== "ACTIVE") {
      throw new BusinessRuleError("MODIFIER_NOT_86ED", "That modifier has already been restored.");
    }

    if (current.outage.version !== input.expectedVersion) {
      throw new ConcurrencyError("modifier 86 record", input.outageId);
    }

    const now = new Date();
    const [row] = await transaction
      .update(modifierOutages)
      .set({
        status: "RESTORED",
        restoredAt: now,
        restoredByUserId: actor.userId,
        updatedAt: now,
        version: sql`${modifierOutages.version} + 1`,
      })
      .where(eq(modifierOutages.id, input.outageId))
      .returning();

    await recordAudit(transaction, actor, {
      action: "menu.modifier-restored",
      entityId: current.outage.modifierId,
      details: { modifierCode: current.modifierCode, outageId: input.outageId },
    });
    await announceModifier(transaction, actor, current.outage.modifierId, "RESTORED", now);

    return row!;
  });
}

// ------------------------------------------------------------------ sell anyway

export async function setSellAnyway(
  database: Database,
  actor: Actor,
  input: { menuItemId: string; reason: string },
) {
  assertPermission(actor, "menu.availability.manage");

  const reason = cleanReason(input.reason);

  try {
    return await withTransaction(database, async (transaction) => {
      const item = await requireActiveItem(transaction, actor, input.menuItemId);
      const now = new Date();
      const settings = await loadLocationMenuSettings(transaction, actor.organizationId, actor.locationId);

      if (!settings.auto86FromStock) {
        throw new BusinessRuleError(
          "AUTO_86_DISABLED",
          "Auto-86 is off at this location, so nothing needs a sell-anyway override.",
        );
      }

      const signals = await loadStockSignals(transaction, {
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        menuItemIds: [item.id],
        at: now,
        withPortions: true,
      });
      const [row] = await transaction
        .insert(menuItemStockOverrides)
        .values({
          organizationId: actor.organizationId,
          locationId: actor.locationId,
          menuItemId: item.id,
          businessDate: signals.businessDate,
          reason,
          setAt: now,
          setByUserId: actor.userId,
        })
        .returning();

      await recordAudit(transaction, actor, {
        action: "menu.sell-anyway-set",
        entityId: item.id,
        details: { itemCode: item.code, overrideId: row!.id, businessDate: signals.businessDate, reason },
      });
      await announce(transaction, actor, item.id, "SELL_ANYWAY_SET", now);

      return row!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("SELL_ANYWAY_ALREADY_SET", "That item is already set to sell anyway today.");
    }

    throw error;
  }
}

export async function clearSellAnyway(
  database: Database,
  actor: Actor,
  input: { overrideId: string; expectedVersion: number },
) {
  assertPermission(actor, "menu.availability.manage");

  return withTransaction(database, async (transaction) => {
    const [current] = await transaction
      .select({ override: menuItemStockOverrides, itemCode: menuItems.code })
      .from(menuItemStockOverrides)
      .innerJoin(menuItems, eq(menuItems.id, menuItemStockOverrides.menuItemId))
      .where(
        and(
          eq(menuItemStockOverrides.id, input.overrideId),
          eq(menuItemStockOverrides.organizationId, actor.organizationId),
          eq(menuItemStockOverrides.locationId, actor.locationId),
        ),
      )
      .for("update", { of: menuItemStockOverrides });

    if (!current) {
      throw new NotFoundError("sell-anyway record");
    }

    if (current.override.clearedAt !== null) {
      throw new BusinessRuleError("SELL_ANYWAY_CLEARED", "That override has already been cleared.");
    }

    if (current.override.version !== input.expectedVersion) {
      throw new ConcurrencyError("sell-anyway record", input.overrideId);
    }

    const now = new Date();
    const [row] = await transaction
      .update(menuItemStockOverrides)
      .set({
        clearedAt: now,
        clearedByUserId: actor.userId,
        updatedAt: now,
        version: sql`${menuItemStockOverrides.version} + 1`,
      })
      .where(eq(menuItemStockOverrides.id, input.overrideId))
      .returning();

    await recordAudit(transaction, actor, {
      action: "menu.sell-anyway-cleared",
      entityId: current.override.menuItemId,
      details: {
        itemCode: current.itemCode,
        overrideId: input.overrideId,
        businessDate: current.override.businessDate,
      },
    });
    await announce(transaction, actor, current.override.menuItemId, "SELL_ANYWAY_CLEARED", now);

    return row!;
  });
}

// ------------------------------------------------------------------ setting

export async function getAuto86Setting(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "menu.view");

  const [row] = await executor
    .select({
      enabled: locationSettings.auto86FromStock,
      runningLowPortions: locationSettings.runningLowPortions,
      version: locationSettings.version,
    })
    .from(locationSettings)
    .where(eq(locationSettings.locationId, actor.locationId));

  if (!row) {
    throw new NotFoundError("location");
  }

  return row;
}

/**
 * Policy A4: opt-in per location, under the existing location settings permission. Phase 20
 * (policy 5) sets the running-low threshold here too, in the same audit action.
 */
export async function setAuto86FromStock(
  database: Database,
  actor: Actor,
  input: { enabled: boolean; runningLowPortions?: number; expectedVersion: number },
) {
  assertPermission(actor, "locations.manage");

  return withTransaction(database, async (transaction) => {
    const now = new Date();
    const [updated] = await transaction
      .update(locationSettings)
      .set({
        auto86FromStock: input.enabled,
        ...(input.runningLowPortions === undefined ? {} : { runningLowPortions: input.runningLowPortions }),
        version: sql`${locationSettings.version} + 1`,
        updatedAt: now,
      })
      .where(and(eq(locationSettings.locationId, actor.locationId), eq(locationSettings.version, input.expectedVersion)))
      .returning({
        enabled: locationSettings.auto86FromStock,
        runningLowPortions: locationSettings.runningLowPortions,
        version: locationSettings.version,
      });

    if (!updated) {
      throw new ConcurrencyError("location settings", actor.locationId);
    }

    await recordAudit(transaction, actor, {
      action: "menu.stock-availability-setting-changed",
      entityId: actor.locationId,
      after: { enabled: updated.enabled, runningLowPortions: updated.runningLowPortions },
    });
    await writeOutboxEvents(transaction, [
      {
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        eventType: AVAILABILITY_CHANGED_EVENT,
        aggregateType: "location",
        aggregateId: actor.locationId,
        payload: { change: "AUTO_86_SETTING" },
        occurredAt: now,
      },
    ]);

    return updated;
  });
}

// ------------------------------------------------------------------ board

export type StockBoardItem = {
  menuItemId: string;
  code: string;
  name: string;
  available: boolean;
  state: SellabilityState;
  portions: number | null;
  runningLow: boolean;
  limitingIngredient: { id: string; name: string } | null;
  outage: {
    id: string;
    reason: string;
    markedOutAt: string;
    markedOutByUserId: string;
    endsAt: string | null;
    version: number;
  } | null;
  override: { id: string; reason: string; setAt: string; setByUserId: string; version: number } | null;
};

/** Phase 20: an 86 on the board that isn't in effect right now, or a modifier 86. */
export type BoardOutage = {
  outageId: string;
  kind: "ITEM" | "MODIFIER";
  targetId: string;
  code: string;
  name: string;
  reason: string;
  markedOutByUserId: string;
  startsAt: string;
  endsAt: string | null;
  version: number;
};

export type StockBoard = {
  businessDate: string;
  auto86FromStock: boolean;
  canManage: boolean;
  items: StockBoardItem[];
  restoredToday: { outageId: string; menuItemId: string; code: string; name: string; reason: string; restoredAt: string; restoredByUserId: string }[];
  /** Phase 20 (policy 5). */
  runningLowPortions: number;
  /** Phase 20 (policy 4): item and modifier 86es that start later. */
  scheduled: BoardOutage[];
  /** Phase 20 (policy 4): item and modifier 86es whose end passed today. */
  endedToday: BoardOutage[];
  /** Phase 20 (policy 3): modifier 86es in effect now. */
  modifiersOut: BoardOutage[];
  /** Active modifiers, for the "86 a modifier" form. */
  modifierChoices: { id: string; code: string; name: string }[];
};

/** Items on the menus offered at the actor's location, active in the catalog. */
async function itemsOfferedHere(executor: DatabaseExecutor, actor: Actor) {
  return executor
    .selectDistinct({ id: menuItems.id, code: menuItems.code, name: menuItems.name, available: menuItems.available })
    .from(menuItems)
    .innerJoin(menuItemPlacements, eq(menuItemPlacements.menuItemId, menuItems.id))
    .innerJoin(menus, eq(menus.id, menuItemPlacements.menuId))
    .innerJoin(menuLocations, eq(menuLocations.menuId, menus.id))
    .where(
      and(
        eq(menuItems.organizationId, actor.organizationId),
        eq(menuItems.active, true),
        eq(menuItemPlacements.active, true),
        eq(menus.active, true),
        eq(menuLocations.locationId, actor.locationId),
        eq(menuLocations.active, true),
      ),
    )
    .orderBy(asc(menuItems.name));
}

/**
 * Policy A7: the 86 board, and the "N left" figures the order screen reads. Who acted is
 * returned as user IDs; screens resolve names, so Menu reads no other domain's people.
 */
export async function getStockBoard(executor: DatabaseExecutor, actor: Actor, at = new Date()): Promise<StockBoard> {
  assertPermission(actor, "menu.view");

  const offered = await itemsOfferedHere(executor, actor);
  const signals = await loadStockSignals(executor, {
    organizationId: actor.organizationId,
    locationId: actor.locationId,
    menuItemIds: offered.map((item) => item.id),
    at,
    withPortions: true,
    availability: new Map(offered.map((item) => [item.id, item.available])),
  });
  const settings = await loadLocationMenuSettings(executor, actor.organizationId, actor.locationId);
  const dayStart = businessDateStart(signals.businessDate, settings);
  const restored = await executor
    .select({ outage: menuItemOutages, code: menuItems.code, name: menuItems.name })
    .from(menuItemOutages)
    .innerJoin(menuItems, eq(menuItems.id, menuItemOutages.menuItemId))
    .where(
      and(
        eq(menuItemOutages.organizationId, actor.organizationId),
        eq(menuItemOutages.locationId, actor.locationId),
        isNotNull(menuItemOutages.restoredAt),
        gte(menuItemOutages.restoredAt, dayStart),
      ),
    )
    .orderBy(asc(menuItemOutages.restoredAt));
  const ingredientIds = [...signals.items.values()]
    .map((signal) => signal.limitingInventoryItemId)
    .filter((id): id is string => id !== null);
  const ingredientNames = await findInventoryItemNames(executor, actor.organizationId, ingredientIds);
  const outagesNotNow = await boardOutages(executor, actor, at, dayStart);

  return {
    businessDate: signals.businessDate,
    auto86FromStock: signals.auto86FromStock,
    canManage: actorHolds(actor, "menu.availability.manage"),
    items: offered.map((item) => {
      const signal = signals.items.get(item.id)!;

      return {
        menuItemId: item.id,
        code: item.code,
        name: item.name,
        available: item.available,
        state: signal.state,
        portions: signal.portions,
        runningLow: isRunningLow(signal.portions, signals.runningLowPortions),
        limitingIngredient: signal.limitingInventoryItemId
          ? { id: signal.limitingInventoryItemId, name: ingredientNames.get(signal.limitingInventoryItemId) ?? "" }
          : null,
        outage: signal.outage && {
          id: signal.outage.id,
          reason: signal.outage.reason,
          markedOutAt: signal.outage.markedOutAt.toISOString(),
          markedOutByUserId: signal.outage.markedOutByUserId,
          endsAt: signal.outage.endsAt?.toISOString() ?? null,
          version: signal.outage.version,
        },
        override: signal.override && {
          id: signal.override.id,
          reason: signal.override.reason,
          setAt: signal.override.setAt.toISOString(),
          setByUserId: signal.override.setByUserId,
          version: signal.override.version,
        },
      };
    }),
    restoredToday: restored.map((row) => ({
      outageId: row.outage.id,
      menuItemId: row.outage.menuItemId,
      code: row.code,
      name: row.name,
      reason: row.outage.reason,
      restoredAt: row.outage.restoredAt!.toISOString(),
      restoredByUserId: row.outage.restoredByUserId!,
    })),
    runningLowPortions: signals.runningLowPortions,
    scheduled: outagesNotNow.filter((entry) => entry.phase === "SCHEDULED").map(withoutPhase),
    endedToday: outagesNotNow.filter((entry) => entry.phase === "ENDED").map(withoutPhase),
    modifiersOut: outagesNotNow.filter((entry) => entry.phase === "IN_EFFECT").map(withoutPhase),
    modifierChoices: await executor
      .select({ id: modifiers.id, code: modifiers.code, name: modifiers.name })
      .from(modifiers)
      .where(and(eq(modifiers.organizationId, actor.organizationId), eq(modifiers.active, true)))
      .orderBy(asc(modifiers.name)),
  };
}

function withoutPhase(entry: BoardOutage & { phase: string }): BoardOutage {
  const { outageId, kind, targetId, code, name, reason, markedOutByUserId, startsAt, endsAt, version } = entry;

  return { outageId, kind, targetId, code, name, reason, markedOutByUserId, startsAt, endsAt, version };
}

/**
 * ACTIVE outages the board lists apart from the item rows: item 86es that start later or
 * ended today, and every modifier 86 that is in effect, scheduled or ended today.
 */
async function boardOutages(executor: DatabaseExecutor, actor: Actor, at: Date, dayStart: Date) {
  const items = await executor
    .select({ outage: menuItemOutages, code: menuItems.code, name: menuItems.name })
    .from(menuItemOutages)
    .innerJoin(menuItems, eq(menuItems.id, menuItemOutages.menuItemId))
    .where(
      and(
        eq(menuItemOutages.organizationId, actor.organizationId),
        eq(menuItemOutages.locationId, actor.locationId),
        eq(menuItemOutages.status, "ACTIVE"),
        or(gt(menuItemOutages.startsAt, at), and(lte(menuItemOutages.endsAt, at), gte(menuItemOutages.endsAt, dayStart))),
      ),
    )
    .orderBy(asc(menuItemOutages.startsAt));
  const modifierRows = await executor
    .select({ outage: modifierOutages, code: modifiers.code, name: modifiers.name })
    .from(modifierOutages)
    .innerJoin(modifiers, eq(modifiers.id, modifierOutages.modifierId))
    .where(
      and(
        eq(modifierOutages.organizationId, actor.organizationId),
        eq(modifierOutages.locationId, actor.locationId),
        eq(modifierOutages.status, "ACTIVE"),
        or(isNull(modifierOutages.endsAt), gte(modifierOutages.endsAt, dayStart)),
      ),
    )
    .orderBy(asc(modifierOutages.startsAt));
  const view = (
    kind: BoardOutage["kind"],
    outage: { id: string; reason: string; markedOutByUserId: string; startsAt: Date; endsAt: Date | null; version: number },
    target: { id: string; code: string; name: string },
  ) => ({
    phase: outagePhase(outage, at),
    outageId: outage.id,
    kind,
    targetId: target.id,
    code: target.code,
    name: target.name,
    reason: outage.reason,
    markedOutByUserId: outage.markedOutByUserId,
    startsAt: outage.startsAt.toISOString(),
    endsAt: outage.endsAt?.toISOString() ?? null,
    version: outage.version,
  });

  return [
    ...items.map((row) => view("ITEM", row.outage, { id: row.outage.menuItemId, code: row.code, name: row.name })),
    ...modifierRows.map((row) =>
      view("MODIFIER", row.outage, { id: row.outage.modifierId, code: row.code, name: row.name }),
    ),
  ];
}
