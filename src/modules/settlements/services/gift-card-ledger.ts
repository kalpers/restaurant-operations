import { and, eq, sql } from "drizzle-orm";

import { giftCardEntries, giftCardPrograms, giftCards } from "@/db/schema";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { readOrderLocation } from "@/modules/orders/repositories/order-repository";
import { addDecimals, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

import { canonicalGiftCardCode, formatGiftCardNumber, hashGiftCardCode } from "../rules/gift-card-code";
import { assertCardCovers } from "../rules/gift-card-math";

// Phase 31 (policy 7, amendment 3): the one place gift card entries are written. Every entry
// locks the card row first, so entries of one card are serialized and each continues the
// running balance that migration 0073 checks. The card's balance moves with the entry.

export type GiftCardEntryKind =
  | "ISSUED"
  | "RELOADED"
  | "SALE_VOIDED"
  | "REDEEMED"
  | "REDEMPTION_VOIDED"
  | "REFUNDED"
  | "REFUND_VOIDED"
  | "ADJUSTED"
  | "CASHED_OUT"
  | "ESCHEATED";

export type GiftCardEntryInput = {
  kind: GiftCardEntryKind;
  /** Signed: positive adds value to the card. */
  amount: string;
  saleId?: string | null;
  tenderId?: string | null;
  refundId?: string | null;
  cashDrawerSessionId?: string | null;
  reason?: string | null;
};

export type GiftCardRow = typeof giftCards.$inferSelect;
export type GiftCardProgram = typeof giftCardPrograms.$inferSelect;

/** One message for any code that doesn't open a card, so a wrong code reveals nothing. */
export function giftCardNotFound(): BusinessRuleError {
  return new BusinessRuleError("GIFT_CARD_NOT_FOUND", "No gift card has that code. Check it and try again.");
}

/** Phase 34 (amendment 9): a registered supplier card that hasn't been sold yet. */
export function giftCardNotSold(): BusinessRuleError {
  return new BusinessRuleError("GIFT_CARD_NOT_SOLD", "This card hasn't been sold yet. Sell it first.");
}

/** The organization's program, or the default (off) when none has been saved. */
export async function readGiftCardProgram(executor: DatabaseExecutor, organizationId: string): Promise<GiftCardProgram> {
  const [row] = await executor.select().from(giftCardPrograms).where(eq(giftCardPrograms.organizationId, organizationId));

  return (
    row ?? {
      organizationId,
      enabled: false,
      maxBalance: "500.00",
      dormancyMonths: 36,
      supplierStockRequired: false,
      enabledAt: null,
      updatedByUserId: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      version: 0,
    }
  );
}

/** The card's id for a typed or scanned code, or null. Never logs or returns the code. */
export async function findGiftCardIdByCode(
  executor: DatabaseExecutor,
  organizationId: string,
  code: string,
): Promise<string | null> {
  const normalized = canonicalGiftCardCode(code);

  if (!normalized) {
    return null;
  }

  const [row] = await executor
    .select({ id: giftCards.id })
    .from(giftCards)
    .where(and(eq(giftCards.codeHash, hashGiftCardCode(normalized)), eq(giftCards.organizationId, organizationId)));

  return row?.id ?? null;
}

/** The SHA-256 of a code for idempotency fingerprints (amendment 1); null if it can't be one. */
export function codeFingerprint(code: string | null | undefined): string | null {
  const normalized = code ? canonicalGiftCardCode(code) : null;

  return normalized ? hashGiftCardCode(normalized) : null;
}

/** Locks a card of the actor's organization (any location: cards are organization-wide). */
export async function lockGiftCard(transaction: DatabaseTransaction, actor: Actor, cardId: string): Promise<GiftCardRow> {
  const [row] = await transaction
    .select()
    .from(giftCards)
    .where(and(eq(giftCards.id, cardId), eq(giftCards.organizationId, actor.organizationId)))
    .for("update");

  if (!row) {
    throw new NotFoundError("gift card");
  }

  return row;
}

/** Locks the card a code opens, or refuses with the one not-found message. */
export async function lockGiftCardByCode(transaction: DatabaseTransaction, actor: Actor, code: string): Promise<GiftCardRow> {
  const cardId = await findGiftCardIdByCode(transaction, actor.organizationId, code);

  if (!cardId) {
    throw giftCardNotFound();
  }

  return lockGiftCard(transaction, actor, cardId);
}

export function assertCardActive(card: GiftCardRow): void {
  // Phase 34 (amendment 9): registered stock holds nothing until it is sold.
  if (card.status === "STOCK") {
    throw giftCardNotSold();
  }

  if (card.status !== "ACTIVE") {
    throw new BusinessRuleError("GIFT_CARD_INACTIVE", `Gift card ${formatGiftCardNumber(card.cardNumber)} is inactive.`);
  }
}

/**
 * Writes one entry and moves the card's balance with it, in the caller's transaction, on the
 * actor's location and business date. The card must already be locked (`lockGiftCard`). The
 * caller has checked the business rule; PostgreSQL refuses a negative balance or a broken chain.
 */
export async function postGiftCardEntry(
  transaction: DatabaseTransaction,
  actor: Actor,
  card: GiftCardRow,
  entry: GiftCardEntryInput,
  at: Date = new Date(),
): Promise<{ entryId: string; balanceAfter: string; businessDate: string }> {
  if (entry.amount.startsWith("-")) {
    assertCardCovers(entry.amount.slice(1), card.balance);
  }

  const balanceAfter = toScale(addDecimals(card.balance, entry.amount), 2);
  const location = await readOrderLocation(transaction, actor.locationId, at);
  const [row] = await transaction
    .insert(giftCardEntries)
    .values({
      organizationId: actor.organizationId,
      giftCardId: card.id,
      kind: entry.kind,
      amount: toScale(entry.amount, 2),
      balanceAfter,
      locationId: actor.locationId,
      businessDate: location.businessDate,
      saleId: entry.saleId ?? null,
      tenderId: entry.tenderId ?? null,
      refundId: entry.refundId ?? null,
      cashDrawerSessionId: entry.cashDrawerSessionId ?? null,
      reason: entry.reason ?? null,
      createdByUserId: actor.userId,
      occurredAt: at,
    })
    .returning({ id: giftCardEntries.id });

  await transaction
    .update(giftCards)
    .set({ balance: balanceAfter, updatedAt: at, version: sql`${giftCards.version} + 1` })
    .where(eq(giftCards.id, card.id));

  // Callers that post twice in one transaction keep working from the new balance.
  card.balance = balanceAfter;
  card.version += 1;

  return { entryId: row!.id, balanceAfter, businessDate: location.businessDate };
}
