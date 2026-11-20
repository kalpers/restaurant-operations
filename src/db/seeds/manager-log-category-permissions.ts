import { DEFAULT_MANAGER_LOG_CATEGORIES, managerLogCategories, organizations } from "../schema";
import type { PermissionCode } from "../../modules/auth/permission-catalog";
import { seedPermissionCodes } from "./permission-grants";
import type { Seed } from "./run-seeds";

/** The code Phase 33 added: configurable manager log categories (policy 18). */
const PHASE_33_CODES: readonly PermissionCode[] = ["manager-log.categories"];

/** Upgrades a Phase 32 database with the Phase 33 code and its system-role grants. */
export const securityManagerLogCategoryPermissionsSeed: Seed = {
  key: "security.manager-log-category-permissions",
  run: (transaction) => seedPermissionCodes(transaction, PHASE_33_CODES),
};

/**
 * Phase 33 (policy 19, amendment 2): the six default categories for every organization that
 * has none. Migration 0077 covers organizations that existed before it; this covers a fresh
 * database, whose organization is created by the seeds after the migrations ran.
 */
export const restaurantManagerLogCategoriesSeed: Seed = {
  key: "restaurant.manager-log-categories",
  run: async (transaction) => {
    const rows = await transaction.select({ id: organizations.id }).from(organizations);

    for (const row of rows) {
      await transaction
        .insert(managerLogCategories)
        .values(DEFAULT_MANAGER_LOG_CATEGORIES.map((category) => ({ organizationId: row.id, ...category })))
        .onConflictDoNothing({ target: [managerLogCategories.organizationId, managerLogCategories.code] });
    }

  },
};
