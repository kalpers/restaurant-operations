import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../src/db";
import { guestLoyaltyEntries, guestLoyaltyPrograms, guestLoyaltyRewards, guestProfiles } from "../src/db/schema";
import type { Actor } from "../src/modules/auth/types";
import {
  adjustLoyaltyPoints,
  createLoyaltyReward,
  updateLoyaltyProgram,
} from "../src/modules/reservations/services/loyalty-service";

// Phase 30 (policy 16): turns the loyalty program on with two rewards and gives the demo guest
// profiles starting points, through the services a manager would use. Each step skips what
// already exists, so a rerun adds nothing and hand edits survive. Local dev DB only.

const DEMO_REWARDS = [
  { name: "Free fries", pointsCost: 50, scope: "ITEM" as const, discountType: "PERCENTAGE" as const, value: "100" },
  { name: "$10 off the check", pointsCost: 150, scope: "ORDER" as const, discountType: "FIXED_AMOUNT" as const, value: "10.00" },
];

const DEMO_STARTING_POINTS: Readonly<Record<string, number>> = {
  "Demo Guest Peanut": 180,
  "Demo Guest Milk": 40,
};

export async function seedDemoLoyalty(
  database: Database,
  manager: Actor,
  adjuster: Actor,
): Promise<{ programEnabled: boolean; rewards: number; profiles: number }> {
  const [program] = await database
    .select({ organizationId: guestLoyaltyPrograms.organizationId })
    .from(guestLoyaltyPrograms)
    .where(eq(guestLoyaltyPrograms.organizationId, manager.organizationId));
  let programEnabled = false;

  if (!program) {
    await updateLoyaltyProgram(database, manager, {
      enabled: true,
      pointsPerDollar: 1,
      pointsPerVisit: 5,
      expectedVersion: 0,
    });
    programEnabled = true;
  }

  const existingRewards = await database
    .select({ name: guestLoyaltyRewards.name })
    .from(guestLoyaltyRewards)
    .where(eq(guestLoyaltyRewards.organizationId, manager.organizationId));
  const names = new Set(existingRewards.map((row) => row.name));
  let rewards = 0;

  for (const reward of DEMO_REWARDS) {
    if (!names.has(reward.name)) {
      await createLoyaltyReward(database, manager, reward);
      rewards += 1;
    }
  }

  const profiles = await database
    .select({ id: guestProfiles.id, displayName: guestProfiles.displayName })
    .from(guestProfiles)
    .where(
      and(
        eq(guestProfiles.organizationId, adjuster.organizationId),
        eq(guestProfiles.status, "ACTIVE"),
        inArray(guestProfiles.displayName, Object.keys(DEMO_STARTING_POINTS)),
      ),
    );
  let given = 0;

  for (const profile of profiles) {
    const [entry] = await database
      .select({ id: guestLoyaltyEntries.id })
      .from(guestLoyaltyEntries)
      .where(eq(guestLoyaltyEntries.guestProfileId, profile.id))
      .limit(1);

    if (!entry) {
      await adjustLoyaltyPoints(database, adjuster, profile.id, {
        points: DEMO_STARTING_POINTS[profile.displayName]!,
        reason: "Demo starting points",
      });
      given += 1;
    }
  }

  return { programEnabled, rewards, profiles: given };
}
