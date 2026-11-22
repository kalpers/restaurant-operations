import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { giftCardEscheatments, giftCards, settlementTenders, settlements } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { BusinessRuleError, ConflictError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { compareDecimals, subtractDecimals, toScale } from "@/shared/decimal/decimal";

import { formatGiftCardNumber } from "../rules/gift-card-code";
import { looksLikeCardNumber } from "../rules/settlement-math";
import { assertPermission } from "./access";
import { giftCardNotSold, lockGiftCard, postGiftCardEntry } from "./gift-card-ledger";

// Phase 34 (policy 6, amendment 10): a balance the restaurant reported to a state as unclaimed
// property and paid over. The card's whole balance leaves through one `ESCHEATED` entry at
// the actor's location and business date, the card is deactivated, and the filing details
// are kept once. It is never undone: the guest now claims from the state, outside the app.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type UnclaimedReport = {
  giftNumber: string;
  amount: string;
  state: string;
  filingReference: string;
  reportDate: string;
  businessDate: string;
};

export async function reportGiftCardUnclaimed(
  database: Database,
  actor: Actor,
  cardId: string,
  input: { state: string; filingReference: string; reportDate: string; expectedVersion: number },
): Promise<UnclaimedReport> {
  assertPermission(actor, "gift-cards.view");
  assertPermission(actor, "gift-cards.manage");

  const state = input.state.trim().toUpperCase();
  const filingReference = input.filingReference.trim();

  if (!/^[A-Z]{2}$/.test(state)) {
    throw new BusinessRuleError("INVALID_STATE", "Enter the state as two letters, for example CA.");
  }

  if (!filingReference || filingReference.length > 60) {
    throw new BusinessRuleError("FILING_REFERENCE_REQUIRED", "Enter the filing reference, up to 60 characters.");
  }

  if (looksLikeCardNumber(filingReference)) {
    throw new BusinessRuleError("CARD_DATA_REFUSED", "Don't enter card numbers.");
  }

  if (!DATE.test(input.reportDate) || Number.isNaN(Date.parse(`${input.reportDate}T00:00:00Z`))) {
    throw new BusinessRuleError("INVALID_REPORT_DATE", "Enter the date the report was filed.");
  }

  return withTransaction(database, async (transaction) => {
    const card = await lockGiftCard(transaction, actor, cardId);

    if (card.version !== input.expectedVersion) {
      throw new ConcurrencyError("gift card", cardId);
    }

    if (card.status === "STOCK" || card.issuedAt === null) {
      throw giftCardNotSold();
    }

    const [already] = await transaction
      .select({ id: giftCardEscheatments.giftCardId })
      .from(giftCardEscheatments)
      .where(eq(giftCardEscheatments.giftCardId, card.id));

    if (already) {
      throw new ConflictError("GIFT_CARD_ALREADY_REPORTED", `${formatGiftCardNumber(card.cardNumber)} was already reported as unclaimed.`);
    }

    if (compareDecimals(card.balance, "0") <= 0) {
      throw new BusinessRuleError("GIFT_CARD_NO_BALANCE", `${formatGiftCardNumber(card.cardNumber)} has no balance to report.`);
    }

    // A tender on a check still being settled could be voided back onto the card.
    const [pending] = await transaction
      .select({ id: settlementTenders.id })
      .from(settlementTenders)
      .innerJoin(settlements, eq(settlements.id, settlementTenders.settlementId))
      .where(and(eq(settlementTenders.giftCardId, card.id), eq(settlements.status, "OPEN")))
      .limit(1);

    if (pending) {
      throw new BusinessRuleError(
        "GIFT_CARD_SETTLEMENT_OPEN",
        "This card is on a check that is still being settled. Finish or void that settlement first.",
      );
    }

    const now = new Date();
    const amount = card.balance;
    const posted = await postGiftCardEntry(
      transaction,
      actor,
      card,
      { kind: "ESCHEATED", amount: toScale(subtractDecimals("0", amount), 2), reason: `Reported as unclaimed (${state} ${filingReference})` },
      now,
    );

    await transaction.insert(giftCardEscheatments).values({
      giftCardId: card.id,
      organizationId: actor.organizationId,
      state,
      filingReference,
      reportDate: input.reportDate,
      amount,
      locationId: actor.locationId,
      businessDate: posted.businessDate,
      reportedByUserId: actor.userId,
      reportedAt: now,
    });
    await transaction
      .update(giftCards)
      .set({ status: "INACTIVE", statusReason: "Reported as unclaimed", updatedAt: now, version: sql`${giftCards.version} + 1` })
      .where(eq(giftCards.id, card.id));

    const report: UnclaimedReport = {
      giftNumber: formatGiftCardNumber(card.cardNumber),
      amount,
      state,
      filingReference,
      reportDate: input.reportDate,
      businessDate: posted.businessDate,
    };

    await recordAudit(transaction, actor, {
      action: "settlements.gift-card-reported-unclaimed",
      entityId: card.id,
      occurredAt: now,
      after: { ...report, balanceAfter: posted.balanceAfter },
    });

    return report;
  });
}
