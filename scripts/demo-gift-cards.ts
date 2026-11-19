import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../src/db";
import { giftCards, kitchenTicketItems, menuItems } from "../src/db/schema";
import type { Actor } from "../src/modules/auth/types";
import { transitionTicketItem } from "../src/modules/kitchen/services/fulfillment-service";
import { addDraftItem } from "../src/modules/orders/services/draft-item-service";
import { createOrder } from "../src/modules/orders/services/order-service";
import { getGiftCardProgram, sellGiftCard, updateGiftCardProgram } from "../src/modules/settlements/services/gift-card-service";
import { openSettlement, recordTender, type RecordTenderInput } from "../src/modules/settlements/services/settlement-service";
import { compareDecimals, subtractDecimals } from "../src/shared/decimal/decimal";
import { completeSettlement } from "../src/workflows/close-order/complete-settlement";
import { sendOrderItems } from "../src/workflows/submit-order/submit-order";

// Phase 31 (policy 17): turns gift cards on, sells three cards (paid on the external terminal,
// so no drawer is needed), reloads one, and spends one on a closed takeout check, through the
// services staff would use. It runs only while the organization has no gift card at all, so a
// rerun adds nothing. Local dev DB only. The codes are printed once for the person running it,
// like the screen that shows them once at the counter; they are not stored anywhere.

const DEMO_CARDS = ["25.00", "50.00", "100.00"] as const;
const DEMO_RELOAD = "25.00";
const DEMO_CHECK_ITEMS = ["FRENCH_FRIES", "HOUSE_IPA"] as const;

const CARD_TENDER: Omit<RecordTenderInput, "expectedVersion" | "idempotencyKey" | "tenderType" | "amount"> = {
  outcome: "RECORDED",
  tipAmount: null,
  receivedAmount: null,
  externalReference: null,
  providerName: null,
  cardBrand: null,
  cardLastFour: null,
  authorizationReference: null,
  otherDescription: null,
  failureReason: null,
};

export async function seedDemoGiftCards(
  database: Database,
  manager: Actor,
  server: Actor,
): Promise<{ summary: string; codes: { cardNumber: string; code: string; balance: string }[] }> {
  const [existing] = await database
    .select({ id: giftCards.id })
    .from(giftCards)
    .where(eq(giftCards.organizationId, manager.organizationId))
    .limit(1);

  if (existing) {
    return { summary: "already there (the organization has gift cards)", codes: [] };
  }

  const program = await getGiftCardProgram(database, manager);

  if (!program.enabled) {
    await updateGiftCardProgram(database, manager, {
      enabled: true,
      maxBalance: program.maxBalance,
      expectedVersion: program.version,
    });
  }

  const sold = [];

  for (const amount of DEMO_CARDS) {
    const sale = await sellGiftCard(database, server, {
      idempotencyKey: randomUUID(),
      amount,
      tenderType: "EXTERNAL_CARD",
      cardBrand: "Visa",
    });

    sold.push({ cardNumber: sale.card.cardNumber, code: sale.code!, balance: sale.card.balance });
  }

  // The first card is reloaded.
  const reloaded = await sellGiftCard(database, server, {
    idempotencyKey: randomUUID(),
    giftCardCode: sold[0]!.code,
    amount: DEMO_RELOAD,
    tenderType: "EXTERNAL_CARD",
  });

  sold[0]!.balance = reloaded.card.balance;

  // The second card pays part of a takeout check of fries and a beer; the rest goes on a card.
  const items = await database
    .select({ id: menuItems.id, code: menuItems.code })
    .from(menuItems)
    .where(and(eq(menuItems.organizationId, server.organizationId), inArray(menuItems.code, [...DEMO_CHECK_ITEMS])));
  const itemId = new Map(items.map((row) => [row.code, row.id]));

  if (DEMO_CHECK_ITEMS.some((code) => !itemId.has(code))) {
    return { summary: "3 cards sold and 1 reloaded; no check paid (the demo kitchen's fries or beer are missing)", codes: sold };
  }

  const order = await createOrder(database, server, { orderType: "TAKEOUT", customerName: "Gift card demo" });
  let version = order.version;

  for (const code of DEMO_CHECK_ITEMS) {
    version = (
      await addDraftItem(database, server, order.id, {
        expectedVersion: version,
        menuItemId: itemId.get(code)!,
        quantity: 1,
        selections: [],
        specialInstructions: null,
      })
    ).orderVersion;
  }

  await sendOrderItems(database, server, order.id, { expectedVersion: version, idempotencyKey: randomUUID() });

  const steps = { NEW: ["start", "ready", "complete"], PREPARING: ["ready", "complete"], READY: ["complete"] } as const;

  for (const item of await database.select().from(kitchenTicketItems).where(eq(kitchenTicketItems.orderId, order.id))) {
    let itemVersion = item.version;

    for (const action of steps[item.status as keyof typeof steps] ?? []) {
      itemVersion = (await transitionTicketItem(database, manager, item.id, action, { expectedVersion: itemVersion })).version;
    }
  }

  const opened = await openSettlement(database, server, order.id);
  const due = opened.orderAmountSnapshot;
  const card = sold[1]!;
  const fromCard = compareDecimals(due, "10.00") > 0 ? "10.00" : due;
  const paid = await recordTender(database, server, opened.settlementId, {
    ...CARD_TENDER,
    idempotencyKey: randomUUID(),
    expectedVersion: opened.settlementVersion,
    tenderType: "GIFT_CARD",
    amount: fromCard,
    giftCardCode: card.code,
  });
  let settlementVersion = paid.settlementVersion;

  if (paid.remainingAmount !== "0.00") {
    settlementVersion = (
      await recordTender(database, server, opened.settlementId, {
        ...CARD_TENDER,
        idempotencyKey: randomUUID(),
        expectedVersion: settlementVersion,
        tenderType: "EXTERNAL_CARD",
        amount: paid.remainingAmount,
      })
    ).settlementVersion;
  }

  await completeSettlement(database, server, opened.settlementId, {
    expectedVersion: settlementVersion,
    idempotencyKey: randomUUID(),
  });
  card.balance = subtractDecimals(card.balance, fromCard);

  return {
    summary: `gift cards on, ${DEMO_CARDS.length} cards sold, 1 reloaded, ${fromCard} spent on a closed takeout check`,
    codes: sold,
  };
}
