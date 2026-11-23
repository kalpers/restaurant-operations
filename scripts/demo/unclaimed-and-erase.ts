import { randomUUID } from "node:crypto";

import { and, asc, eq, ilike, isNotNull, isNull, like, lt } from "drizzle-orm";

import type { Database } from "../../src/db";
import {
  giftCardEscheatments,
  giftCardPurchasers,
  giftCards,
  giftCardStockBatches,
  guestProfiles,
  menuItems,
  orders,
  schedulePeriods,
  shifts,
} from "../../src/db/schema";
import type { Actor } from "../../src/modules/auth/types";
import { addDraftItem } from "../../src/modules/orders/services/draft-item-service";
import { createOrder } from "../../src/modules/orders/services/order-service";
import { createGuestProfile } from "../../src/modules/reservations/services/guest-profile-service";
import { createShift } from "../../src/modules/scheduling/services/schedule-service";
import { savePurchaser } from "../../src/modules/settlements/services/gift-card-purchaser-service";
import { getGiftCardProgram, sellGiftCard } from "../../src/modules/settlements/services/gift-card-service";
import { deactivateStock, registerStockBatch } from "../../src/modules/settlements/services/gift-card-stock-service";
import { reportGiftCardUnclaimed } from "../../src/modules/settlements/services/gift-card-unclaimed-service";
import { openSettlement } from "../../src/modules/settlements/services/settlement-service";
import { completeSettlement } from "../../src/workflows/close-order/complete-settlement";
import { sendOrderItems } from "../../src/workflows/submit-order/submit-order";
import { voidOrderItem } from "../../src/workflows/void-order-item/void-order-item";
import { installShiftedClock, restoreClock, setClock } from "./clock";

// Phase 34 (policy 17): a registered box of supplier cards (two sold, one deactivated),
// purchaser details on the old unused card, one card reported as unclaimed, and a demo guest
// named in a takeout check and a shift note so an erase has something to find. Everything goes
// through the services staff would use; each step skips what already exists, so a rerun adds
// nothing. Local dev DB only. The stock codes are fixed demo codes, printed below.

const STOCK_BATCH = "Demo: PrintCo box of 10";
export const DEMO_STOCK_CODES = Array.from({ length: 10 }, (_, index) => `DEMOSTK${String(index + 1).padStart(4, "0")}`);
const ERASE_GUEST = { name: "Dana Whitfield", phone: "(555) 010-4477", email: "dana.whitfield@example.test" } as const;
/** Older than the default 36-month unused-balance period. */
const UNUSED_MONTHS_AGO = 40;

export async function seedDemoPhase34(database: Database, owner: Actor): Promise<string[]> {
  const lines: string[] = [];
  const program = await getGiftCardProgram(database, owner);

  if (!program.enabled) {
    lines.push("gift card steps skipped (gift cards are off)");
  } else {
    lines.push(await seedStock(database, owner));
    lines.push(await seedPurchaser(database, owner));
    lines.push(await seedUnclaimed(database, owner));
  }

  lines.push(await seedEraseGuest(database, owner));
  lines.push(await seedTakeoutMention(database, owner));
  lines.push(await seedShiftMention(database, owner));

  return lines;
}

async function seedStock(database: Database, owner: Actor): Promise<string> {
  const [existing] = await database
    .select({ id: giftCardStockBatches.id })
    .from(giftCardStockBatches)
    .where(and(eq(giftCardStockBatches.organizationId, owner.organizationId), eq(giftCardStockBatches.description, STOCK_BATCH)));

  if (existing) {
    return "card stock already there";
  }

  const batch = await registerStockBatch(database, owner, {
    idempotencyKey: randomUUID(),
    description: STOCK_BATCH,
    lines: DEMO_STOCK_CODES.map((code, index) => `PC-${String(index + 1).padStart(3, "0")},${code}`),
  });

  for (const code of DEMO_STOCK_CODES.slice(0, 2)) {
    await sellGiftCard(database, owner, { idempotencyKey: randomUUID(), supplierCode: code, amount: "25.00", tenderType: "EXTERNAL_CARD", cardBrand: "Visa" });
  }

  const [damaged] = await database
    .select({ id: giftCards.id, version: giftCards.version })
    .from(giftCards)
    .where(and(eq(giftCards.stockBatchId, batch.batchId), eq(giftCards.printedSerial, "PC-010")));

  await deactivateStock(database, owner, batch.batchId, { reason: "Demo: card arrived damaged", cardId: damaged!.id, expectedVersion: damaged!.version });

  return `registered ${batch.batchNumber} (${batch.firstCard} to ${batch.lastCard}): 2 sold, 1 deactivated, codes ${DEMO_STOCK_CODES[0]} to ${DEMO_STOCK_CODES.at(-1)}`;
}

function monthsAgo(months: number): Date {
  const at = new Date();

  at.setMonth(at.getMonth() - months);
  at.setUTCHours(18, 0, 0, 0);

  return at;
}

/** Purchaser details on the oldest unused card (the Phase 33 demo card). */
async function seedPurchaser(database: Database, owner: Actor): Promise<string> {
  const cutoff = monthsAgo(UNUSED_MONTHS_AGO - 1);
  const [card] = await database
    .select({ id: giftCards.id, cardNumber: giftCards.cardNumber, purchaser: giftCardPurchasers.giftCardId })
    .from(giftCards)
    .leftJoin(giftCardPurchasers, eq(giftCardPurchasers.giftCardId, giftCards.id))
    .where(and(eq(giftCards.organizationId, owner.organizationId), lt(giftCards.issuedAt, cutoff), eq(giftCards.status, "ACTIVE")))
    .orderBy(asc(giftCards.cardNumber))
    .limit(1);

  if (!card) {
    return "purchaser skipped (no old unused card)";
  }

  if (card.purchaser) {
    return "purchaser details already there";
  }

  await savePurchaser(database, owner, card.id, {
    details: { name: "Jordan Demo-Buyer", addressLine1: "12 Sample Street", city: "Ann Arbor", region: "MI", postalCode: "48104", country: "US" },
    expectedVersion: null,
  });

  return `purchaser details on GC-${String(card.cardNumber).padStart(6, "0")}`;
}

/** A second card sold long ago and reported to the state as unclaimed. */
async function seedUnclaimed(database: Database, owner: Actor): Promise<string> {
  const [reported] = await database
    .select({ id: giftCardEscheatments.giftCardId })
    .from(giftCardEscheatments)
    .where(eq(giftCardEscheatments.organizationId, owner.organizationId))
    .limit(1);

  if (reported) {
    return "unclaimed report already there";
  }

  installShiftedClock();

  let cardId: string;

  try {
    setClock(monthsAgo(UNUSED_MONTHS_AGO + 2));
    cardId = (await sellGiftCard(database, owner, { idempotencyKey: randomUUID(), amount: "18.00", tenderType: "EXTERNAL_CARD", cardBrand: "Visa" }))
      .card.id;
  } finally {
    restoreClock();
  }

  const [card] = await database.select({ version: giftCards.version }).from(giftCards).where(eq(giftCards.id, cardId));
  const report = await reportGiftCardUnclaimed(database, owner, cardId, {
    state: "MI",
    filingReference: "DEMO-MI-2026-001",
    reportDate: new Date().toISOString().slice(0, 10),
    expectedVersion: card!.version,
  });

  return `reported ${report.giftNumber} (${report.amount}) as unclaimed to ${report.state}`;
}

async function seedEraseGuest(database: Database, owner: Actor): Promise<string> {
  const [existing] = await database
    .select({ id: guestProfiles.id })
    .from(guestProfiles)
    .where(and(eq(guestProfiles.organizationId, owner.organizationId), eq(guestProfiles.displayName, ERASE_GUEST.name), isNull(guestProfiles.erasedAt)));

  if (existing) {
    return `guest ${ERASE_GUEST.name} already there`;
  }

  await createGuestProfile(database, owner, {
    displayName: ERASE_GUEST.name,
    phone: ERASE_GUEST.phone,
    email: ERASE_GUEST.email,
    vip: false,
    vipReason: null,
    preferences: null,
    notes: null,
    otherDietaryNeeds: null,
  });

  return `guest ${ERASE_GUEST.name} to try an erase on`;
}

/** A takeout check named after the demo guest, with an instruction naming her; voided and closed at zero. */
async function seedTakeoutMention(database: Database, owner: Actor): Promise<string> {
  const [existing] = await database
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.organizationId, owner.organizationId), like(orders.customerName, "%Whitfield%")))
    .limit(1);

  if (existing) {
    return "takeout mention already there";
  }

  const [knots] = await database
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(and(eq(menuItems.organizationId, owner.organizationId), eq(menuItems.code, "GARLIC_KNOTS")));

  if (!knots) {
    return "takeout mention skipped (no Garlic Knots on the demo menu)";
  }

  const order = await createOrder(database, owner, { orderType: "TAKEOUT", customerName: "D. Whitfield" });
  const added = await addDraftItem(database, owner, order.id, {
    expectedVersion: order.version,
    menuItemId: knots.id,
    quantity: 1,
    selections: [],
    specialInstructions: "Whitfield: extra marinara, call 555-010-4477 when ready",
  });
  const sent = await sendOrderItems(database, owner, order.id, { expectedVersion: added.orderVersion, idempotencyKey: randomUUID() });
  const voided = await voidOrderItem(database, owner, order.id, added.itemId, {
    reason: "Demo: guest cancelled",
    disposition: "UNPREPARED",
    expectedVersion: sent.orderVersion,
  });
  const { settlementId, settlementVersion } = await openSettlement(database, owner, order.id);

  await completeSettlement(database, owner, settlementId, { expectedVersion: settlementVersion, idempotencyKey: randomUUID() });

  return `takeout check for D. Whitfield (voided, closed at zero; order version ${voided.version})`;
}

/** A note on a future draft shift that names the demo guest. */
async function seedShiftMention(database: Database, owner: Actor): Promise<string> {
  const [existing] = await database
    .select({ id: shifts.id })
    .from(shifts)
    .where(and(eq(shifts.locationId, owner.locationId), ilike(shifts.notes, "%Whitfield%")))
    .limit(1);

  if (existing) {
    return "shift note already there";
  }

  const [draft] = await database
    .select({ id: schedulePeriods.id, version: schedulePeriods.version, startDate: schedulePeriods.startDate, positionId: shifts.positionId })
    .from(schedulePeriods)
    .innerJoin(shifts, eq(shifts.schedulePeriodId, schedulePeriods.id))
    .where(and(eq(schedulePeriods.locationId, owner.locationId), eq(schedulePeriods.status, "DRAFT"), isNotNull(shifts.positionId)))
    .orderBy(asc(schedulePeriods.startDate))
    .limit(1);

  if (!draft) {
    return "shift note skipped (no draft schedule)";
  }

  await createShift(database, owner, draft.id, {
    positionId: draft.positionId,
    restaurantAreaId: null,
    shiftDate: draft.startDate,
    startTime: "17:00",
    endTime: "22:00",
    requiredEmployeeCount: 1,
    courseOrStationNote: null,
    notes: "Whitfield party of 8 at 7, extra server in the back room",
    priority: 0,
    expectedPeriodVersion: draft.version,
  });

  return `shift note naming Whitfield in the draft week of ${draft.startDate}`;
}
