import { randomBytes, randomUUID } from "node:crypto";

import { eq, inArray, like } from "drizzle-orm";

import { loadLocalEnv, pointAtTestDatabase } from "../../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../../src/db";
import {
  locations,
  menuAvailability,
  menuCategories,
  menuItemModifierGroups,
  menuItemPlacements,
  menuItemPrepRouting,
  menuItemPrices,
  menuItems,
  menuLocations,
  menus,
  modifierGroupModifiers,
  modifierGroups,
  modifiers,
  permissions,
  prepStations,
  recipes,
  recipeVersions,
  rolePermissions,
  roles,
  userRoles,
  users,
} from "../../src/db/schema";
import { hashPassword } from "../../src/modules/auth/password";
import type { PermissionCode } from "../../src/modules/auth/permission-catalog";
import {
  getUserAuthContext,
  requirePermission,
} from "../../src/modules/auth/services/permission-service";
import type { Actor } from "../../src/modules/auth/types";
import {
  createGroup,
  createModifier,
  setGroupModifier,
} from "../../src/modules/menu/services/modifier-service";
import { clearAuditEvents } from "../fixtures/audit-cleanup";
import { clearStockSignalRows } from "./e2e-stock-signals";

loadLocalEnv();
pointAtTestDatabase();

export type MenuAccount = { id: string; email: string; password: string };

/**
 * Spec files run in parallel and each removes what it created when it finishes, so each
 * gets its own markers: a different email domain, role prefix and code prefix.
 */
export function createMenuE2e(scope: "MENU" | "RECIPES") {
  const EMAIL_DOMAIN = `${scope.toLowerCase()}-e2e.example.test`;
  const ROLE_PREFIX = `${scope}_E2E_`;
  /** Prefix for every menu, recipe and station code this spec creates. */
  const CODE_PREFIX = scope === "MENU" ? "E2EM_" : "E2ER_";


  const uniqueCode = (suffix = "") =>
    `${CODE_PREFIX}${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}${suffix}`;

  async function mainLocation() {
    const [location] = await getDatabase()
      .select({ id: locations.id, organizationId: locations.organizationId })
      .from(locations)
      .where(eq(locations.locationCode, "MAIN"));

    return location!;
  }

  async function insertAccount(roleId: string): Promise<MenuAccount> {
    const database = getDatabase();
    const location = await mainLocation();
    const email = `user-${randomUUID()}@${EMAIL_DOMAIN}`;
    const password = randomBytes(24).toString("base64url");
    const [user] = await database
      .insert(users)
      .values({
        email,
        normalizedEmail: email,
        passwordHash: await hashPassword(password),
      })
      .returning({ id: users.id });

    await database
      .insert(userRoles)
      .values({ userId: user!.id, roleId, locationId: location.id });

    return { id: user!.id, email, password };
  }

  async function createRoleAccount(roleCode: string): Promise<MenuAccount> {
    const [role] = await getDatabase()
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.code, roleCode));

    return insertAccount(role!.id);
  }

  async function createPermissionAccount(
    codes: readonly PermissionCode[],
  ): Promise<MenuAccount> {
    const database = getDatabase();
    const { organizationId } = await mainLocation();
    const [role] = await database
      .insert(roles)
      .values({
        organizationId,
        code: `${ROLE_PREFIX}${randomUUID().replaceAll("-", "_").toUpperCase()}`,
        name: "Menu E2E fixture",
      })
      .returning({ id: roles.id });
    const rows = await database
      .select({ id: permissions.id })
      .from(permissions)
      .where(inArray(permissions.code, [...codes]));

    if (rows.length > 0) {
      await database
        .insert(rolePermissions)
        .values(rows.map((row) => ({ roleId: role!.id, permissionId: row.id })));
    }

    return insertAccount(role!.id);
  }

  async function actorOf(account: MenuAccount): Promise<Actor> {
    const location = await mainLocation();
    const context = await getUserAuthContext(getDatabase(), account.id);

    return requirePermission(context!, {
      permission: "menu.view",
      locationId: location.id,
    });
  }

  /** A required single-choice group of modifiers, ready to attach to an item. */
  async function createGroupFixture(
    account: MenuAccount,
    options: { name: string; modifiers: { name: string; priceAdjustment: string }[] },
  ): Promise<{ id: string; name: string }> {
    const database = getDatabase();
    const actor = await actorOf(account);
    const group = await createGroup(database, actor, {
      code: uniqueCode("_G"),
      name: options.name,
      description: null,
      selectionType: "REQUIRED_SINGLE",
      minimumSelections: 1,
      maximumSelections: 1,
      displayOrder: 0,
    });

    for (const [index, entry] of options.modifiers.entries()) {
      const modifier = await createModifier(database, actor, {
        code: uniqueCode(`_M${index}`),
        name: entry.name,
        description: null,
        priceAdjustment: entry.priceAdjustment,
        preparationEffectType: "NONE",
        preparationInstruction: null,
      });

      await setGroupModifier(database, actor, group.id, {
        modifierId: modifier.id,
        displayOrder: index,
        active: true,
      });
    }

    return { id: group.id, name: options.name };
  }

  async function removeMenuE2eData(): Promise<void> {
    const database = getDatabase();
    const itemIds = (
      await database
        .select({ id: menuItems.id })
        .from(menuItems)
        .where(like(menuItems.code, `${CODE_PREFIX}%`))
    ).map((row) => row.id);
    const categoryIds = (
      await database
        .select({ id: menuCategories.id })
        .from(menuCategories)
        .where(like(menuCategories.code, `${CODE_PREFIX}%`))
    ).map((row) => row.id);
    const menuIds = (
      await database
        .select({ id: menus.id })
        .from(menus)
        .where(like(menus.code, `${CODE_PREFIX}%`))
    ).map((row) => row.id);
    const groupIds = (
      await database
        .select({ id: modifierGroups.id })
        .from(modifierGroups)
        .where(like(modifierGroups.code, `${CODE_PREFIX}%`))
    ).map((row) => row.id);
    const modifierIds = (
      await database
        .select({ id: modifiers.id })
        .from(modifiers)
        .where(like(modifiers.code, `${CODE_PREFIX}%`))
    ).map((row) => row.id);
    const stationIds = (
      await database
        .select({ id: prepStations.id })
        .from(prepStations)
        .where(like(prepStations.code, `${CODE_PREFIX}%`))
    ).map((row) => row.id);
    const recipeIds = (
      await database
        .select({ id: recipes.id })
        .from(recipes)
        .where(like(recipes.code, `${CODE_PREFIX}%`))
    ).map((row) => row.id);

    if (recipeIds.length) {
      // Published revisions can't be deleted through the application, so this test cleanup
      // lifts the trigger for its own session.
      await database.transaction(async (transaction) => {
        await transaction.execute(
          "ALTER TABLE recipe_versions DISABLE TRIGGER recipe_versions_forbid_published_delete_trigger" as never,
        );
        await transaction.delete(recipeVersions).where(inArray(recipeVersions.recipeId, recipeIds));
        await transaction.execute(
          "ALTER TABLE recipe_versions ENABLE TRIGGER recipe_versions_forbid_published_delete_trigger" as never,
        );
      });
      await database.delete(recipes).where(inArray(recipes.id, recipeIds));
    }

    if (itemIds.length) {
      await database.delete(menuItemPrepRouting).where(inArray(menuItemPrepRouting.menuItemId, itemIds));
      await database.delete(menuItemPrices).where(inArray(menuItemPrices.menuItemId, itemIds));
      await database.delete(menuItemModifierGroups).where(inArray(menuItemModifierGroups.menuItemId, itemIds));
      await database.delete(menuItemPlacements).where(inArray(menuItemPlacements.menuItemId, itemIds));
    }

    if (categoryIds.length) {
      await database.delete(menuItemPlacements).where(inArray(menuItemPlacements.menuCategoryId, categoryIds));
    }

    if (menuIds.length) {
      await database.delete(menuItemPlacements).where(inArray(menuItemPlacements.menuId, menuIds));
      await database.delete(menuAvailability).where(inArray(menuAvailability.menuId, menuIds));
      await database.delete(menuLocations).where(inArray(menuLocations.menuId, menuIds));
      await database.delete(menus).where(inArray(menus.id, menuIds));
    }

    if (groupIds.length) {
      await database.delete(menuItemModifierGroups).where(inArray(menuItemModifierGroups.modifierGroupId, groupIds));
      await database.delete(modifierGroupModifiers).where(inArray(modifierGroupModifiers.modifierGroupId, groupIds));
    }

    if (modifierIds.length) {
      await database.delete(modifierGroupModifiers).where(inArray(modifierGroupModifiers.modifierId, modifierIds));
    }

    if (groupIds.length) {
      await database.delete(modifierGroups).where(inArray(modifierGroups.id, groupIds));
    }

    if (modifierIds.length) {
      await database.delete(modifiers).where(inArray(modifiers.id, modifierIds));
    }

    if (itemIds.length) {
      await database.transaction((transaction) => clearStockSignalRows(transaction, { menuItemIds: itemIds }));
      await database.delete(menuItems).where(inArray(menuItems.id, itemIds));
    }

    if (categoryIds.length) {
      await database.delete(menuCategories).where(inArray(menuCategories.id, categoryIds));
    }

    if (stationIds.length) {
      await database.delete(menuItemPrepRouting).where(inArray(menuItemPrepRouting.prepStationId, stationIds));
      await database.delete(prepStations).where(inArray(prepStations.id, stationIds));
    }

    const accounts = await database
      .select({ id: users.id })
      .from(users)
      .where(like(users.normalizedEmail, `%@${EMAIL_DOMAIN}`));
    const userIds = accounts.map((row) => row.id);

    if (userIds.length) {
      await database.transaction((transaction) => clearStockSignalRows(transaction, { userIds }));
      await database.delete(userRoles).where(inArray(userRoles.userId, userIds));
      await clearAuditEvents(database, { userIds: userIds });
      await database.delete(users).where(inArray(users.id, userIds));
    }

    const fixtureRoles = await database
      .select({ id: roles.id })
      .from(roles)
      .where(like(roles.code, `${ROLE_PREFIX}%`));
    const roleIds = fixtureRoles.map((row) => row.id);

    if (roleIds.length) {
      await database.delete(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
      await database.delete(roles).where(inArray(roles.id, roleIds));
    }

    await closeDatabase();
  }

  return {
    CODE_PREFIX,
    uniqueCode,
    createRoleAccount,
    createPermissionAccount,
    createGroupFixture,
    removeMenuE2eData,
  };
}
