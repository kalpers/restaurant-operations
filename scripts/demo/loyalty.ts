import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../../src/db";
import {
  guestLoyaltyEntries,
  guestLoyaltyPrograms,
  guestLoyaltyRedemptions,
  guestLoyaltyRewards,
  guestProfiles,
  kitchenTicketItems,
  menuItems,
  orderItems,
  settlements,
  tableSessions,
} from "../../src/db/schema";
import type { Actor } from "../../src/modules/auth/types";
import { transitionTicketItem } from "../../src/modules/kitchen/services/fulfillment-service";
import { addDraftItem } from "../../src/modules/orders/services/draft-item-service";
import { createOrder } from "../../src/modules/orders/services/order-service";
import {
  adjustLoyaltyPoints,
  createLoyaltyReward,
  updateLoyaltyProgram,
} from "../../src/modules/reservations/services/loyalty-service";
import { getFloorStatus } from "../../src/modules/restaurant/services/floor-service";
import { cleanTable } from "../../src/modules/restaurant/services/table-service";
import { openSettlement, recordTender } from "../../src/modules/settlements/services/settlement-service";
import { completeSettlement } from "../../src/workflows/close-order/complete-settlement";
import { completeTableSession } from "../../src/workflows/end-table-session/end-table-session";
import { redeemLoyaltyReward } from "../../src/workflows/redeem-loyalty-reward/redeem-loyalty-reward";
import { seatWalkIn } from "../../src/workflows/seat-guest-party/seat-guest-party";
import { sendOrderItems } from "../../src/workflows/submit-order/submit-order";

// Phase 30 (policy 16): turns the loyalty program on with two rewards, gives the demo guest
// profiles starting points, and runs one visit where a reward is redeemed, through the services
// staff would use. Each step skips what already exists, so a rerun adds nothing and hand edits
// survive. Local dev DB only.

const DEMO_REWARDS = [
  { name: "Free garlic knots", pointsCost: 50, scope: "ITEM" as const, discountType: "PERCENTAGE" as const, value: "100" },
  { name: "$10 off the check", pointsCost: 150, scope: "ORDER" as const, discountType: "FIXED_AMOUNT" as const, value: "10.00" },
];

const DEMO_STARTING_POINTS: Readonly<Record<string, number>> = {
  "Demo Guest Peanut": 180,
  "Demo Guest Milk": 40,
  "Demo Guest Gluten": 95,
};

/** The demo visit with a reward: this guest, these items, and the item the reward is for. */
const DEMO_REDEMPTION = {
  guest: "Demo Guest Peanut",
  reward: "Free garlic knots",
  items: ["GARLIC_KNOTS", "DRAFT_LAGER"],
  rewardItem: "GARLIC_KNOTS",
} as const;

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

/**
 * One finished visit at the actor's location where the demo guest redeems "Free garlic knots":
 * a walk-in linked to the profile, knots and a lager sent, the reward redeemed on the knots, the
 * kitchen and bar work completed, the check settled by external card (so no cash drawer is
 * needed), the guests leave (the visit earns its points) and the table is cleaned. Skipped once
 * the guest has any redemption, and when the program is off, the guest or reward is missing, or
 * no clean dining table is free. Returns what it did, for the seed's summary.
 */
export async function seedDemoRedemption(database: Database, actor: Actor): Promise<string> {
  const [program] = await database
    .select({ enabled: guestLoyaltyPrograms.enabled })
    .from(guestLoyaltyPrograms)
    .where(eq(guestLoyaltyPrograms.organizationId, actor.organizationId));

  if (!program?.enabled) {
    return "skipped (the loyalty program is off)";
  }

  const [profile] = await database
    .select({ id: guestProfiles.id })
    .from(guestProfiles)
    .where(
      and(
        eq(guestProfiles.organizationId, actor.organizationId),
        eq(guestProfiles.status, "ACTIVE"),
        eq(guestProfiles.displayName, DEMO_REDEMPTION.guest),
      ),
    );

  if (!profile) {
    return `skipped (no active "${DEMO_REDEMPTION.guest}" profile)`;
  }

  const [already] = await database
    .select({ id: guestLoyaltyRedemptions.id })
    .from(guestLoyaltyRedemptions)
    .where(eq(guestLoyaltyRedemptions.guestProfileId, profile.id))
    .limit(1);

  if (already) {
    return "already there";
  }

  const [reward] = await database
    .select({ id: guestLoyaltyRewards.id })
    .from(guestLoyaltyRewards)
    .where(
      and(
        eq(guestLoyaltyRewards.organizationId, actor.organizationId),
        eq(guestLoyaltyRewards.name, DEMO_REDEMPTION.reward),
        eq(guestLoyaltyRewards.active, true),
      ),
    );

  if (!reward) {
    return `skipped (no active "${DEMO_REDEMPTION.reward}" reward)`;
  }

  const items = await database
    .select({ id: menuItems.id, code: menuItems.code })
    .from(menuItems)
    .where(and(eq(menuItems.organizationId, actor.organizationId), inArray(menuItems.code, [...DEMO_REDEMPTION.items])));
  const itemId = new Map(items.map((row) => [row.code, row.id]));

  if (DEMO_REDEMPTION.items.some((code) => !itemId.has(code))) {
    return "skipped (the garlic knots or draft lager are missing)";
  }

  const table = (await getFloorStatus(database, actor)).find(
    (candidate) => candidate.area.type === "DINING" && candidate.availability === "AVAILABLE" && candidate.capacity >= 2,
  );

  if (!table) {
    return "skipped (no clean, free dining table)";
  }

  // Seated, linked to the profile (its allergies come onto the visit), knots and a lager sent.
  const seated = await seatWalkIn(database, actor, {
    guestName: DEMO_REDEMPTION.guest,
    partySize: 2,
    tableIds: [table.id],
    guestProfileId: profile.id,
  });
  const order = await createOrder(database, actor, { orderType: "DINE_IN", tableSessionId: seated.id });
  let version = order.version;

  for (const code of DEMO_REDEMPTION.items) {
    version = (
      await addDraftItem(database, actor, order.id, {
        expectedVersion: version,
        menuItemId: itemId.get(code)!,
        quantity: 1,
        selections: [],
        specialInstructions: null,
      })
    ).orderVersion;
  }

  version = (await sendOrderItems(database, actor, order.id, { expectedVersion: version, idempotencyKey: randomUUID() }))
    .orderVersion;

  // The reward goes on the knots.
  const [knots] = await database
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, order.id), eq(orderItems.menuItemId, itemId.get(DEMO_REDEMPTION.rewardItem)!)));

  await redeemLoyaltyReward(database, actor, order.id, {
    rewardId: reward.id,
    orderItemId: knots!.id,
    expectedVersion: version,
    idempotencyKey: randomUUID(),
  });

  // The kitchen and bar finish the work.
  const steps = { NEW: ["start", "ready", "complete"], PREPARING: ["ready", "complete"], READY: ["complete"] } as const;

  for (const item of await database.select().from(kitchenTicketItems).where(eq(kitchenTicketItems.orderId, order.id))) {
    let itemVersion = item.version;

    for (const action of steps[item.status as keyof typeof steps] ?? []) {
      itemVersion = (await transitionTicketItem(database, actor, item.id, action, { expectedVersion: itemVersion })).version;
    }
  }

  // Settled by external card; closing posts the reward's points.
  const opened = await openSettlement(database, actor, order.id);

  if (opened.orderAmountSnapshot !== "0.00") {
    await recordTender(database, actor, opened.settlementId, {
      idempotencyKey: randomUUID(),
      expectedVersion: opened.settlementVersion,
      tenderType: "EXTERNAL_CARD",
      outcome: "RECORDED",
      amount: opened.orderAmountSnapshot,
      tipAmount: null,
      receivedAmount: null,
      externalReference: null,
      providerName: null,
      cardBrand: null,
      cardLastFour: null,
      authorizationReference: null,
      otherDescription: null,
      failureReason: null,
    });
  }

  const [settlement] = await database
    .select({ version: settlements.version })
    .from(settlements)
    .where(eq(settlements.id, opened.settlementId));

  await completeSettlement(database, actor, opened.settlementId, {
    expectedVersion: settlement!.version,
    idempotencyKey: randomUUID(),
  });

  // The guests leave: the visit earns its points; then the table is cleaned.
  const [session] = await database.select({ version: tableSessions.version }).from(tableSessions).where(eq(tableSessions.id, seated.id));

  await completeTableSession(database, actor, seated.id, { expectedVersion: session!.version });

  const dirty = (await getFloorStatus(database, actor)).find((candidate) => candidate.id === table.id);

  if (dirty?.condition === "DIRTY") {
    await cleanTable(database, actor, table.id, { expectedVersion: dirty.version });
  }

  return `redeemed "${DEMO_REDEMPTION.reward}" on check #${order.orderNumber}, closed and earned`;
}
