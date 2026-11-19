import { randomUUID } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";

import { getDatabase } from "../../src/db";
import { giftCards } from "../../src/db/schema";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import type { Actor } from "../../src/modules/auth/types";
import { addDraftItem } from "../../src/modules/orders/services/draft-item-service";
import { createOrder } from "../../src/modules/orders/services/order-service";
import {
  adjustGiftCard,
  getGiftCardProgram,
  updateGiftCardProgram,
} from "../../src/modules/settlements/services/gift-card-service";
import { sendOrderItems } from "../../src/workflows/submit-order/submit-order";

import type { GuestsSetup } from "./e2e-guests";

// Phase 31 E2E: the steps around the screens under test, through the same services the screens
// call. Cards are organization-wide, so the spec leaves none holding value and turns gift cards
// back off when it finishes.

async function ownerAt(setup: GuestsSetup): Promise<Actor> {
  const context = await getUserAuthContext(getDatabase(), setup.owner.id);

  return requirePermission(context!, { permission: "orders.view", locationId: setup.locationId });
}

/** A takeout check with one item sent, ready to settle. */
export async function takeoutCheck(setup: GuestsSetup, menuItemId: string): Promise<string> {
  const database = getDatabase();
  const actor = await ownerAt(setup);
  const order = await createOrder(database, actor, { orderType: "TAKEOUT", customerName: `Gift card E2E ${setup.suffix}` });
  const added = await addDraftItem(database, actor, order.id, {
    expectedVersion: order.version,
    menuItemId,
    quantity: 1,
    selections: [],
    specialInstructions: null,
  });

  await sendOrderItems(database, actor, order.id, { expectedVersion: added.orderVersion, idempotencyKey: randomUUID() });

  return order.id;
}

/** Takes every card's remaining value off with an audited adjustment, then turns gift cards off. */
export async function turnGiftCardsOff(setup: GuestsSetup): Promise<void> {
  const database = getDatabase();
  const actor = await ownerAt(setup);
  const program = await getGiftCardProgram(database, actor);

  if (!program.enabled) {
    return;
  }

  const held = await database
    .select()
    .from(giftCards)
    .where(and(eq(giftCards.organizationId, actor.organizationId), gt(giftCards.balance, "0")));

  for (const card of held) {
    if (card.status === "ACTIVE") {
      await adjustGiftCard(database, actor, card.id, {
        amount: `-${card.balance}`,
        reason: "E2E cleanup",
        expectedVersion: card.version,
      });
    }
  }

  const current = await getGiftCardProgram(database, actor);

  if (current.cardsWithBalance === 0) {
    await updateGiftCardProgram(database, actor, {
      enabled: false,
      maxBalance: current.maxBalance,
      expectedVersion: current.version,
    });
  }
}
