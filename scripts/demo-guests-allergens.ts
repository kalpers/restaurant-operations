import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../src/db";
import {
  allergens,
  guestProfiles,
  ingredientAllergenReviews,
  inventoryItems,
  menuItemAllergenReviews,
  menuItems,
} from "../src/db/schema";
import type { Actor } from "../src/modules/auth/types";
import { setIngredientAllergens, setMenuItemAllergens } from "../src/modules/recipes/services/allergen-service";
import { createGuestProfile, mergeGuestProfiles } from "../src/modules/reservations/services/guest-profile-service";

// Phase 22 (policy 24): the Phase 21 leftover. Allergen tags, a declared MAY_CONTAIN and guest
// profiles for the demo and validation data, all through the services a manager would use.
// Each step skips what already exists, so a rerun adds nothing and hand edits survive.

/** The allergens of the demo kitchen's ingredients (src/db/demo/demo-kitchen.ts). */
export const DEMO_INGREDIENT_ALLERGENS: Readonly<Record<string, readonly string[]>> = {
  GROUND_BEEF: [],
  BRIOCHE_BUN: ["WHEAT", "SESAME", "EGGS"],
  AMERICAN_CHEESE: ["MILK"],
  SWISS_CHEESE: ["MILK"],
  BACON: [],
  YELLOW_ONION: [],
  PICKLE_CHIPS: [],
  FRENCH_FRIES: [],
  CHICKEN_WINGS: [],
  TITOS_VODKA: [],
  LIME_JUICE: [],
  SIMPLE_SYRUP: [],
  HOUSE_IPA: ["WHEAT"],
};

/** Fries share the fryer with breaded items: declared, since no recipe shows it. */
export const DEMO_DECLARED_ALLERGENS = [{ menuItem: "FRENCH_FRIES", allergen: "WHEAT", kind: "MAY_CONTAIN" as const }];

export type DemoProfile = {
  displayName: string;
  vip: boolean;
  vipReason: string | null;
  preferences: string | null;
  allergies: readonly { allergen: string; severity: "SEVERE" | "ALLERGY" }[];
  /** Merged into the profile with this display name once created. */
  mergeInto?: string;
};

async function allergenIds(database: Database, organizationId: string): Promise<Map<string, string>> {
  const rows = await database
    .select({ id: allergens.id, code: allergens.code })
    .from(allergens)
    .where(eq(allergens.organizationId, organizationId));

  if (rows.length === 0) {
    throw new Error("The allergen list isn't seeded. Run `npm run db:seed` first.");
  }

  return new Map(rows.map((row) => [row.code, row.id]));
}

function idsFor(byCode: Map<string, string>, codes: readonly string[]): string[] {
  return codes.map((code) => {
    const id = byCode.get(code);

    if (!id) {
      throw new Error(`Allergen ${code} isn't in the allergen list.`);
    }

    return id;
  });
}

/** Tags and reviews each demo ingredient that has no review yet. Returns how many it tagged. */
export async function seedIngredientAllergens(database: Database, actor: Actor): Promise<number> {
  const byCode = await allergenIds(database, actor.organizationId);
  const items = await database
    .select({ id: inventoryItems.id, code: inventoryItems.code })
    .from(inventoryItems)
    .where(
      and(eq(inventoryItems.organizationId, actor.organizationId), inArray(inventoryItems.code, Object.keys(DEMO_INGREDIENT_ALLERGENS))),
    );

  if (items.length === 0) {
    throw new Error("The demo kitchen isn't seeded. Run `npm run db:seed:demo` first.");
  }

  const reviewed = new Set(
    (
      await database
        .select({ id: ingredientAllergenReviews.inventoryItemId })
        .from(ingredientAllergenReviews)
        .where(inArray(ingredientAllergenReviews.inventoryItemId, items.map((item) => item.id)))
    ).map((row) => row.id),
  );
  let tagged = 0;

  for (const item of items) {
    if (reviewed.has(item.id)) {
      continue;
    }

    await setIngredientAllergens(database, actor, {
      inventoryItemId: item.id,
      allergenIds: idsFor(byCode, DEMO_INGREDIENT_ALLERGENS[item.code] ?? []),
      expectedReviewVersion: null,
    });
    tagged += 1;
  }

  return tagged;
}

/** Declares the demo MAY_CONTAIN allergens on menu items not yet reviewed. */
export async function seedDeclaredAllergens(database: Database, actor: Actor): Promise<number> {
  const byCode = await allergenIds(database, actor.organizationId);
  let declared = 0;

  for (const entry of DEMO_DECLARED_ALLERGENS) {
    const [item] = await database
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(and(eq(menuItems.organizationId, actor.organizationId), eq(menuItems.code, entry.menuItem)));

    if (!item) {
      throw new Error(`Menu item ${entry.menuItem} isn't seeded. Run \`npm run db:seed:demo\` first.`);
    }

    const [review] = await database
      .select({ id: menuItemAllergenReviews.menuItemId })
      .from(menuItemAllergenReviews)
      .where(eq(menuItemAllergenReviews.menuItemId, item.id));

    if (review) {
      continue;
    }

    await setMenuItemAllergens(database, actor, {
      menuItemId: item.id,
      declared: [{ allergenId: idsFor(byCode, [entry.allergen])[0]!, kind: entry.kind }],
      expectedReviewVersion: null,
    });
    declared += 1;
  }

  return declared;
}

/** Creates each profile that doesn't exist yet (by display name), then any merges. */
export async function seedGuestProfiles(database: Database, actor: Actor, profiles: readonly DemoProfile[]): Promise<number> {
  const byCode = await allergenIds(database, actor.organizationId);
  const existing = async (displayName: string) =>
    (
      await database
        .select({ id: guestProfiles.id, version: guestProfiles.version, status: guestProfiles.status })
        .from(guestProfiles)
        .where(and(eq(guestProfiles.organizationId, actor.organizationId), eq(guestProfiles.displayName, displayName)))
    )[0];
  let created = 0;

  for (const profile of profiles) {
    if (await existing(profile.displayName)) {
      continue;
    }

    await createGuestProfile(database, actor, {
      displayName: profile.displayName,
      phone: null,
      email: null,
      vip: profile.vip,
      vipReason: profile.vipReason,
      preferences: profile.preferences,
      notes: null,
      otherDietaryNeeds: null,
      allergies: profile.allergies.map((allergy) => ({
        allergenId: idsFor(byCode, [allergy.allergen])[0]!,
        severity: allergy.severity,
        note: null,
      })),
    });
    created += 1;
  }

  for (const profile of profiles.filter((entry) => entry.mergeInto)) {
    const duplicate = await existing(profile.displayName);
    const kept = await existing(profile.mergeInto!);

    if (duplicate?.status === "ACTIVE" && kept?.status === "ACTIVE") {
      await mergeGuestProfiles(database, actor, {
        duplicateProfileId: duplicate.id,
        duplicateVersion: duplicate.version,
        keptProfileId: kept.id,
        keptVersion: kept.version,
        reason: "Demo data: the same guest booked twice",
      });
    }
  }

  return created;
}
