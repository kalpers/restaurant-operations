import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { isExclusionViolation, isUniqueViolation } from "@/db/helpers/database-errors";
import { updateVersioned } from "@/db/helpers/versioned-update";
import {
  locations,
  menuAvailability,
  menuCategories,
  menuItemPlacements,
  menuItems,
  menuLocations,
  menus,
} from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";

import type { MenuItemType } from "../types";
import { assertPermission } from "./access";

type CodedInput = {
  code: string;
  name: string;
  description: string | null;
  displayOrder: number;
};

const codeTaken = (label: string) =>
  new ConflictError("CODE_TAKEN", `Another ${label} already uses that code.`);

async function insertCoded<Row>(
  label: string,
  insert: () => Promise<Row>,
): Promise<Row> {
  try {
    return await insert();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw codeTaken(label);
    }

    throw error;
  }
}

// ---------------------------------------------------------------- categories

export async function listCategories(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "menu.view");

  return executor
    .select()
    .from(menuCategories)
    .where(eq(menuCategories.organizationId, actor.organizationId))
    .orderBy(asc(menuCategories.displayOrder), asc(menuCategories.name));
}

export async function createCategory(database: Database, actor: Actor, input: CodedInput) {
  assertPermission(actor, "menu.edit");

  return insertCoded("category", async () => {
    const [row] = await database
      .insert(menuCategories)
      .values({ ...input, organizationId: actor.organizationId })
      .returning();

    return row!;
  });
}

export async function updateCategory(
  database: Database,
  actor: Actor,
  categoryId: string,
  input: Omit<CodedInput, "code"> & { active: boolean; expectedVersion: number },
) {
  assertPermission(actor, "menu.edit");

  const { expectedVersion, ...values } = input;

  return updateVersioned(database, menuCategories, {
    id: categoryId,
    organizationId: actor.organizationId,
    expectedVersion,
    values,
    label: "category",
  });
}

// --------------------------------------------------------------------- menus

export async function listMenus(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "menu.view");

  const rows = await executor
    .select()
    .from(menus)
    .where(eq(menus.organizationId, actor.organizationId))
    .orderBy(asc(menus.displayOrder), asc(menus.name));
  const offered = await executor
    .select({
      menuId: menuLocations.menuId,
      locationId: menuLocations.locationId,
      active: menuLocations.active,
    })
    .from(menuLocations)
    .where(eq(menuLocations.organizationId, actor.organizationId));

  return rows.map((menu) => ({
    ...menu,
    locations: offered.filter((entry) => entry.menuId === menu.id),
  }));
}

export async function createMenu(database: Database, actor: Actor, input: CodedInput) {
  assertPermission(actor, "menu.edit");

  return insertCoded("menu", async () => {
    const [row] = await database
      .insert(menus)
      .values({ ...input, organizationId: actor.organizationId })
      .returning();

    return row!;
  });
}

export async function updateMenu(
  database: Database,
  actor: Actor,
  menuId: string,
  input: Omit<CodedInput, "code"> & { active: boolean; expectedVersion: number },
) {
  assertPermission(actor, "menu.edit");

  const { expectedVersion, ...values } = input;

  return updateVersioned(database, menus, {
    id: menuId,
    organizationId: actor.organizationId,
    expectedVersion,
    values,
    label: "menu",
  });
}

async function requireMenu(executor: DatabaseExecutor, actor: Actor, menuId: string) {
  const [menu] = await executor
    .select({ id: menus.id })
    .from(menus)
    .where(and(eq(menus.id, menuId), eq(menus.organizationId, actor.organizationId)));

  if (!menu) {
    throw new NotFoundError("menu");
  }

  return menu;
}

async function requireLocation(executor: DatabaseExecutor, actor: Actor, locationId: string) {
  const [location] = await executor
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(eq(locations.id, locationId), eq(locations.organizationId, actor.organizationId)),
    );

  if (!location) {
    throw new NotFoundError("location");
  }
}

/** Offer a menu at a location, or stop offering it. Creates the link on first use. */
export async function setMenuLocation(
  database: Database,
  actor: Actor,
  menuId: string,
  input: { locationId: string; active: boolean },
) {
  assertPermission(actor, "menu.edit");

  return withTransaction(database, async (transaction) => {
    await requireMenu(transaction, actor, menuId);
    await requireLocation(transaction, actor, input.locationId);

    const [row] = await transaction
      .insert(menuLocations)
      .values({
        organizationId: actor.organizationId,
        menuId,
        locationId: input.locationId,
        active: input.active,
      })
      .onConflictDoUpdate({
        target: [menuLocations.menuId, menuLocations.locationId],
        set: { active: input.active, updatedAt: new Date() },
      })
      .returning();

    return row!;
  });
}

export async function listAvailabilityWindows(
  executor: DatabaseExecutor,
  actor: Actor,
  menuId: string,
) {
  assertPermission(actor, "menu.view");
  await requireMenu(executor, actor, menuId);

  return executor
    .select()
    .from(menuAvailability)
    .where(eq(menuAvailability.menuId, menuId))
    .orderBy(asc(menuAvailability.locationId), asc(menuAvailability.effectiveFrom));
}

/** A window during which the menu is offered at a location (half-open, `[from, to)`). */
export async function addAvailabilityWindow(
  database: Database,
  actor: Actor,
  menuId: string,
  input: { locationId: string; effectiveFrom: Date; effectiveTo: Date | null },
) {
  assertPermission(actor, "menu.edit");

  if (input.effectiveTo !== null && input.effectiveTo <= input.effectiveFrom) {
    throw new BusinessRuleError("INVALID_INTERVAL", "The window must end after it starts.");
  }

  try {
    return await withTransaction(database, async (transaction) => {
      await requireMenu(transaction, actor, menuId);

      const [offered] = await transaction
        .select({ id: menuLocations.id })
        .from(menuLocations)
        .where(
          and(eq(menuLocations.menuId, menuId), eq(menuLocations.locationId, input.locationId)),
        );

      if (!offered) {
        throw new BusinessRuleError(
          "MENU_NOT_OFFERED_AT_LOCATION",
          "Offer the menu at this location before adding availability windows.",
        );
      }

      const [row] = await transaction
        .insert(menuAvailability)
        .values({ ...input, menuId, createdByUserId: actor.userId })
        .returning();

      return row!;
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new ConflictError(
        "AVAILABILITY_OVERLAP",
        "That window overlaps another one for this menu and location.",
      );
    }

    throw error;
  }
}

/** Ends an open-ended window now. Windows are history, so they are closed, not deleted. */
export async function closeAvailabilityWindow(
  database: Database,
  actor: Actor,
  windowId: string,
  now: Date = new Date(),
) {
  assertPermission(actor, "menu.edit");

  return withTransaction(database, async (transaction) => {
    const [window] = await transaction
      .select({
        id: menuAvailability.id,
        effectiveFrom: menuAvailability.effectiveFrom,
        effectiveTo: menuAvailability.effectiveTo,
      })
      .from(menuAvailability)
      .innerJoin(menus, eq(menus.id, menuAvailability.menuId))
      .where(
        and(
          eq(menuAvailability.id, windowId),
          eq(menus.organizationId, actor.organizationId),
        ),
      )
      .for("update", { of: menuAvailability });

    if (!window) {
      throw new NotFoundError("availability window");
    }

    if (window.effectiveTo !== null && window.effectiveTo <= now) {
      return window;
    }

    if (window.effectiveFrom >= now) {
      throw new BusinessRuleError(
        "WINDOW_NOT_STARTED",
        "A window that hasn't started can't be closed; it would be empty.",
      );
    }

    const [row] = await transaction
      .update(menuAvailability)
      .set({ effectiveTo: now })
      .where(eq(menuAvailability.id, windowId))
      .returning();

    return row!;
  });
}

// --------------------------------------------------------------------- items

type ItemInput = {
  name: string;
  shortName: string | null;
  description: string | null;
  itemType: MenuItemType;
  displayOrder: number;
};

export async function listItems(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "menu.view");

  return executor
    .select()
    .from(menuItems)
    .where(eq(menuItems.organizationId, actor.organizationId))
    .orderBy(asc(menuItems.displayOrder), asc(menuItems.name));
}

export async function getItem(executor: DatabaseExecutor, actor: Actor, itemId: string) {
  assertPermission(actor, "menu.view");

  const [item] = await executor
    .select()
    .from(menuItems)
    .where(and(eq(menuItems.id, itemId), eq(menuItems.organizationId, actor.organizationId)));

  if (!item) {
    throw new NotFoundError("menu item");
  }

  return item;
}

export async function createItem(
  database: Database,
  actor: Actor,
  input: ItemInput & { code: string },
) {
  assertPermission(actor, "menu.edit");

  return insertCoded("menu item", async () => {
    const [row] = await database
      .insert(menuItems)
      .values({ ...input, organizationId: actor.organizationId })
      .returning();

    return row!;
  });
}

/** `active` is catalog membership; `available` is whether it can be sold right now. */
export async function updateItem(
  database: Database,
  actor: Actor,
  itemId: string,
  input: ItemInput & { active: boolean; available: boolean; expectedVersion: number },
) {
  assertPermission(actor, "menu.edit");

  const { expectedVersion, ...values } = input;

  return updateVersioned(database, menuItems, {
    id: itemId,
    organizationId: actor.organizationId,
    expectedVersion,
    values,
    label: "menu item",
  });
}

// --------------------------------------------------------------- placements

export async function listPlacements(
  executor: DatabaseExecutor,
  actor: Actor,
  filter: { menuId?: string; menuItemId?: string } = {},
) {
  assertPermission(actor, "menu.view");

  return executor
    .select()
    .from(menuItemPlacements)
    .where(
      and(
        eq(menuItemPlacements.organizationId, actor.organizationId),
        filter.menuId ? eq(menuItemPlacements.menuId, filter.menuId) : undefined,
        filter.menuItemId ? eq(menuItemPlacements.menuItemId, filter.menuItemId) : undefined,
      ),
    )
    .orderBy(asc(menuItemPlacements.displayOrder));
}

/** Puts an item in a category of a menu. The same item may have many placements. */
export async function createPlacement(
  database: Database,
  actor: Actor,
  input: { menuId: string; menuCategoryId: string; menuItemId: string; displayOrder: number },
) {
  assertPermission(actor, "menu.edit");

  try {
    return await withTransaction(database, async (transaction) => {
      await requireMenu(transaction, actor, input.menuId);

      const [category] = await transaction
        .select({ id: menuCategories.id })
        .from(menuCategories)
        .where(
          and(
            eq(menuCategories.id, input.menuCategoryId),
            eq(menuCategories.organizationId, actor.organizationId),
          ),
        );

      if (!category) {
        throw new NotFoundError("category");
      }

      const [item] = await transaction
        .select({ id: menuItems.id })
        .from(menuItems)
        .where(
          and(
            eq(menuItems.id, input.menuItemId),
            eq(menuItems.organizationId, actor.organizationId),
          ),
        );

      if (!item) {
        throw new NotFoundError("menu item");
      }

      const [row] = await transaction
        .insert(menuItemPlacements)
        .values({ ...input, organizationId: actor.organizationId })
        .returning();

      return row!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "PLACEMENT_EXISTS",
        "That item is already placed in this category of this menu.",
      );
    }

    throw error;
  }
}

export async function updatePlacement(
  database: Database,
  actor: Actor,
  placementId: string,
  input: { displayOrder: number; active: boolean; expectedVersion: number },
) {
  assertPermission(actor, "menu.edit");

  const { expectedVersion, ...values } = input;

  return updateVersioned(database, menuItemPlacements, {
    id: placementId,
    organizationId: actor.organizationId,
    expectedVersion,
    values,
    label: "placement",
  });
}

/** Items in no active placement, which no menu shows. For the editor's checklist. */
export async function listUnplacedItems(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "menu.view");

  return executor
    .select({ id: menuItems.id, code: menuItems.code, name: menuItems.name })
    .from(menuItems)
    .leftJoin(
      menuItemPlacements,
      and(
        eq(menuItemPlacements.menuItemId, menuItems.id),
        eq(menuItemPlacements.active, true),
      ),
    )
    .where(
      and(eq(menuItems.organizationId, actor.organizationId), isNull(menuItemPlacements.id)),
    )
    .orderBy(sql`${menuItems.name}`);
}
