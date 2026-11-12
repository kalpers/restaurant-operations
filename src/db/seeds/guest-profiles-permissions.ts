import type { PermissionCode } from "../../modules/auth/permission-catalog";
import { allergens, organizations } from "../schema";
import { seedPermissionCodes } from "./permission-grants";
import type { Seed } from "./run-seeds";

/** The codes Phase 21 added: guest profiles and allergen labels (policy 19, D13). */
const PHASE_21_CODES: readonly PermissionCode[] = [
  "guests.view",
  "guests.contact.view",
  "guests.manage",
  "guests.merge",
  "guests.erase",
  "recipes.allergens.manage",
];

/** Upgrades a Phase 20 database with the Phase 21 codes and their system-role grants. */
export const securityGuestProfilesPermissionsSeed: Seed = {
  key: "security.guest-profiles-permissions",
  run: (transaction) => seedPermissionCodes(transaction, PHASE_21_CODES),
};

/** The nine major US food allergens (policy 6). Managers may add more; codes never change. */
export const MAJOR_ALLERGENS = [
  { code: "MILK", name: "Milk" },
  { code: "EGGS", name: "Eggs" },
  { code: "FISH", name: "Fish" },
  { code: "SHELLFISH", name: "Crustacean shellfish" },
  { code: "TREE_NUTS", name: "Tree nuts" },
  { code: "PEANUTS", name: "Peanuts" },
  { code: "WHEAT", name: "Wheat" },
  { code: "SOY", name: "Soybeans" },
  { code: "SESAME", name: "Sesame" },
] as const;

/** Gives every organization the major allergens. Existing rows (and later renames) are kept. */
export const recipesAllergenFoundationSeed: Seed = {
  key: "recipes.allergen-foundation",
  run: async (transaction) => {
    const rows = await transaction.select({ id: organizations.id }).from(organizations);

    for (const organization of rows) {
      await transaction
        .insert(allergens)
        .values(
          MAJOR_ALLERGENS.map((allergen, index) => ({
            ...allergen,
            organizationId: organization.id,
            displayOrder: (index + 1) * 10,
          })),
        )
        .onConflictDoNothing({ target: [allergens.organizationId, allergens.code] });
    }
  },
};
