import { randomUUID } from "node:crypto";

import { and, eq, inArray, lt } from "drizzle-orm";

import type { Database } from "../../src/db";
import {
  giftCards,
  guestLoyaltyEntries,
  guestLoyaltyRedemptions,
  guestProfiles,
  orderRefunds,
} from "../../src/db/schema";
import type { Actor } from "../../src/modules/auth/types";
import { getGiftCardProgram, sellGiftCard } from "../../src/modules/settlements/services/gift-card-service";
import { recordRefund } from "../../src/workflows/record-refund/record-refund";
import { installShiftedClock, restoreClock, setClock } from "./clock";

// Phase 33 (policy 19): one gift card sold with a supplier's printed code, one card sold long
// enough ago to show under "Unused gift card balances", and a partial refund on the demo
// redemption visit that takes back loyalty points, all through the services staff would use.
// Each step skips what already exists, so a rerun adds nothing. Local dev DB only. The printed
// code is a fixed demo code; the old card's generated code is printed once and not stored.

/** A demo supplier code: letters and digits, never 13 digits in a row. */
const DEMO_SUPPLIER_CODE = "DEMO-PRNT-2026";
/** Older than the default 36-month unused-balance period. */
const UNUSED_MONTHS_AGO = 40;
/** $3.00 back on the lager plus its 6% tax. */
const DEMO_REFUND = { amount: "3.18", taxAmount: "0.18", reason: "Demo: the lager was flat" } as const;
const REDEMPTION_GUEST = "Demo Guest Peanut";

export type FollowUpDemo = { lines: string[]; codes: { cardNumber: string; code: string; balance: string }[] };

export async function seedDemoFollowUps(database: Database, owner: Actor): Promise<FollowUpDemo> {
  const lines: string[] = [];
  const codes: FollowUpDemo["codes"] = [];
  const program = await getGiftCardProgram(database, owner);

  if (!program.enabled) {
    lines.push("gift card steps skipped (gift cards are off)");
  } else {
    const [supplier] = await database
      .select({ id: giftCards.id })
      .from(giftCards)
      .where(and(eq(giftCards.organizationId, owner.organizationId), eq(giftCards.codeSource, "SUPPLIER")))
      .limit(1);

    if (supplier) {
      lines.push("supplier-coded card already there");
    } else {
      const sale = await sellGiftCard(database, owner, {
        idempotencyKey: randomUUID(),
        supplierCode: DEMO_SUPPLIER_CODE,
        amount: "40.00",
        tenderType: "EXTERNAL_CARD",
        cardBrand: "Visa",
      });

      lines.push(`sold ${sale.card.cardNumber} with the printed code ${DEMO_SUPPLIER_CODE}`);
    }

    const cutoff = new Date();

    cutoff.setMonth(cutoff.getMonth() - UNUSED_MONTHS_AGO + 1);

    const [old] = await database
      .select({ id: giftCards.id })
      .from(giftCards)
      .where(and(eq(giftCards.organizationId, owner.organizationId), lt(giftCards.issuedAt, cutoff)))
      .limit(1);

    if (old) {
      lines.push("unused old card already there");
    } else {
      const soldAt = new Date();

      soldAt.setMonth(soldAt.getMonth() - UNUSED_MONTHS_AGO);
      soldAt.setUTCHours(18, 0, 0, 0);
      installShiftedClock();

      try {
        setClock(soldAt);

        const sale = await sellGiftCard(database, owner, {
          idempotencyKey: randomUUID(),
          amount: "15.00",
          tenderType: "EXTERNAL_CARD",
          cardBrand: "Visa",
        });

        codes.push({ cardNumber: sale.card.cardNumber, code: sale.code!, balance: sale.card.balance });
        lines.push(`sold ${sale.card.cardNumber} ${UNUSED_MONTHS_AGO} months ago and never used since`);
      } finally {
        restoreClock();
      }
    }
  }

  lines.push(await seedDemoRefund(database, owner));

  return { lines, codes };
}

/** A partial refund on the demo redemption visit's check, taking back the points it paid for. */
async function seedDemoRefund(database: Database, owner: Actor): Promise<string> {
  const [visit] = await database
    .select({ orderId: guestLoyaltyRedemptions.orderId, partyId: guestLoyaltyRedemptions.guestPartyId })
    .from(guestLoyaltyRedemptions)
    .innerJoin(guestProfiles, eq(guestProfiles.id, guestLoyaltyRedemptions.guestProfileId))
    .where(and(eq(guestProfiles.organizationId, owner.organizationId), eq(guestProfiles.displayName, REDEMPTION_GUEST)))
    .limit(1);

  if (!visit) {
    return "refund skipped (no demo redemption visit)";
  }

  const [earned] = await database
    .select({ id: guestLoyaltyEntries.id })
    .from(guestLoyaltyEntries)
    .where(and(eq(guestLoyaltyEntries.guestPartyId, visit.partyId), inArray(guestLoyaltyEntries.kind, ["EARNED"])));

  if (!earned) {
    return "refund skipped (the demo visit hasn't earned points)";
  }

  const [refunded] = await database
    .select({ id: orderRefunds.id })
    .from(orderRefunds)
    .where(eq(orderRefunds.orderId, visit.orderId))
    .limit(1);

  if (refunded) {
    return "refund already there";
  }

  const result = await recordRefund(database, owner, visit.orderId, {
    idempotencyKey: randomUUID(),
    tenderType: "EXTERNAL_CARD",
    amount: DEMO_REFUND.amount,
    taxAmount: DEMO_REFUND.taxAmount,
    reason: DEMO_REFUND.reason,
    otherDescription: null,
    externalReference: null,
  });

  return `refunded ${DEMO_REFUND.amount} on the demo redemption check: ${result.loyaltyPointsTaken} points taken back`;
}
