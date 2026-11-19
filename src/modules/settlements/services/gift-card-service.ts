import { and, asc, desc, eq, gt, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { giftCardEntries, giftCardNumberCounters, giftCardPrograms, giftCardSales, giftCards } from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { readOrderLocation } from "@/modules/orders/repositories/order-repository";
import { compareDecimals, subtractDecimals, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { formatGiftCardNumber, generateGiftCardCode, parseGiftCardNumber } from "../rules/gift-card-code";
import {
  assertAdjustmentWithinLimits,
  assertCanCashOut,
  assertSaleWithinLimits,
  parseSignedMoney,
  saleChange,
} from "../rules/gift-card-math";
import { looksLikeCardNumber, parseMoney } from "../rules/settlement-math";
import { TENDER_PERMISSIONS } from "../types";
import { assertPermission } from "./access";
import { resolveCashDrawerSession } from "./drawer-service";
import {
  assertCardActive,
  codeFingerprint,
  findGiftCardIdByCode,
  giftCardNotFound,
  lockGiftCard,
  lockGiftCardByCode,
  postGiftCardEntry,
  readGiftCardProgram,
  type GiftCardRow,
} from "./gift-card-ledger";

// Phase 31 gift cards (policies 4–8, 11–14; amendments 1–3). Record only. The code is
// returned once when a card is sold or its code replaced, and is never stored, logged,
// audited or kept in an idempotency response.

export const GIFT_CARD_SALE_SCOPE = "gift-cards.sell";
export const GIFT_CARD_CASH_OUT_SCOPE = "gift-cards.cash-out";

export type GiftCardSaleTenderType = "CASH" | "EXTERNAL_CARD" | "OTHER";

export type GiftCardView = {
  id: string;
  cardNumber: string;
  lastFour: string;
  status: string;
  statusReason: string | null;
  balance: string;
  issuedAt: string;
  version: number;
};

function viewOf(card: GiftCardRow): GiftCardView {
  return {
    id: card.id,
    cardNumber: formatGiftCardNumber(card.cardNumber),
    lastFour: card.codeLastFour,
    status: card.status,
    statusReason: card.statusReason,
    balance: card.balance,
    issuedAt: card.issuedAt.toISOString(),
    version: card.version,
  };
}

/** What a stored idempotency response keeps of a card: not even its last four characters. */
export type StoredGiftCardView = Omit<GiftCardView, "lastFour">;

function storedViewOf(card: GiftCardRow): StoredGiftCardView {
  return {
    id: card.id,
    cardNumber: formatGiftCardNumber(card.cardNumber),
    status: card.status,
    statusReason: card.statusReason,
    balance: card.balance,
    issuedAt: card.issuedAt.toISOString(),
    version: card.version,
  };
}

function assertNoCardNumber(...values: (string | null | undefined)[]) {
  if (values.some(looksLikeCardNumber)) {
    throw new BusinessRuleError("CARD_DATA_REFUSED", "Don't enter card numbers.");
  }
}

function requiredReason(reason: string, max = 200): string {
  const trimmed = reason.trim();

  if (!trimmed || trimmed.length > max) {
    throw new BusinessRuleError("REASON_REQUIRED", `Give a reason of up to ${max} characters.`);
  }

  assertNoCardNumber(trimmed);

  return trimmed;
}

async function assertProgramEnabled(executor: DatabaseExecutor, actor: Actor) {
  const program = await readGiftCardProgram(executor, actor.organizationId);

  if (!program.enabled) {
    throw new BusinessRuleError("GIFT_CARDS_NOT_ENABLED", "Gift cards aren't turned on. A manager can turn them on.");
  }

  return program;
}

// ------------------------------------------------------------------------- Program (policy 8)

export type GiftCardProgramView = {
  enabled: boolean;
  maxBalance: string;
  enabledAt: string | null;
  version: number;
  outstandingBalance: string;
  cardsWithBalance: number;
};

export async function getGiftCardProgram(executor: DatabaseExecutor, actor: Actor): Promise<GiftCardProgramView> {
  assertPermission(actor, "gift-cards.view");

  const program = await readGiftCardProgram(executor, actor.organizationId);
  const [outstanding] = await executor
    .select({
      total: sql<string>`COALESCE(SUM(${giftCards.balance}), 0)::numeric(14,2)::text`,
      cards: sql<number>`COUNT(*) FILTER (WHERE ${giftCards.balance} > 0)::int`,
    })
    .from(giftCards)
    .where(eq(giftCards.organizationId, actor.organizationId));

  return {
    enabled: program.enabled,
    maxBalance: program.maxBalance,
    enabledAt: program.enabledAt?.toISOString() ?? null,
    version: program.version,
    outstandingBalance: outstanding?.total ?? "0.00",
    cardsWithBalance: outstanding?.cards ?? 0,
  };
}

export async function updateGiftCardProgram(
  database: Database,
  actor: Actor,
  input: { enabled: boolean; maxBalance: string; expectedVersion: number },
): Promise<GiftCardProgramView> {
  assertPermission(actor, "gift-cards.view");
  assertPermission(actor, "gift-cards.manage");

  const maxBalance = parseMoney(input.maxBalance, "maximum balance");

  if (compareDecimals(maxBalance, "1.00") < 0 || compareDecimals(maxBalance, "10000.00") > 0) {
    throw new BusinessRuleError("INVALID_MAX_BALANCE", "The maximum balance is between 1.00 and 10,000.00.");
  }

  await withTransaction(database, async (transaction) => {
    await transaction
      .insert(giftCardPrograms)
      .values({ organizationId: actor.organizationId, version: 0 })
      .onConflictDoNothing({ target: giftCardPrograms.organizationId });

    const [current] = await transaction
      .select()
      .from(giftCardPrograms)
      .where(eq(giftCardPrograms.organizationId, actor.organizationId))
      .for("update");

    if (current!.version !== input.expectedVersion) {
      throw new ConcurrencyError("gift card program", actor.organizationId);
    }

    if (current!.enabled && !input.enabled) {
      // Locks nothing on the cards; a sale racing this sees the program row lock above.
      const [held] = await transaction
        .select({ id: giftCards.id })
        .from(giftCards)
        .where(and(eq(giftCards.organizationId, actor.organizationId), gt(giftCards.balance, "0")))
        .limit(1);

      if (held) {
        throw new BusinessRuleError(
          "GIFT_CARDS_OUTSTANDING",
          "Gift cards still hold a balance, so they can't be turned off. Guests' money would be stranded.",
        );
      }
    }

    const now = new Date();

    await transaction
      .update(giftCardPrograms)
      .set({
        enabled: input.enabled,
        maxBalance,
        enabledAt: current!.enabledAt ?? (input.enabled ? now : null),
        updatedByUserId: actor.userId,
        updatedAt: now,
        version: sql`${giftCardPrograms.version} + 1`,
      })
      .where(eq(giftCardPrograms.organizationId, actor.organizationId));
    await recordAudit(transaction, actor, {
      action: "settlements.gift-card-program-changed",
      entityId: actor.organizationId,
      occurredAt: now,
      before: { enabled: current!.enabled, maxBalance: current!.maxBalance },
      after: { enabled: input.enabled, maxBalance },
    });
  });

  return getGiftCardProgram(database, actor);
}

// ------------------------------------------------------------------- Selling (policy 4, A1–A2)

export type SellGiftCardInput = {
  idempotencyKey: string;
  /** A reload names the card by its code; a new card has none. */
  giftCardCode?: string | null;
  amount: string;
  tenderType: GiftCardSaleTenderType;
  receivedAmount?: string | null;
  externalReference?: string | null;
  providerName?: string | null;
  cardBrand?: string | null;
  cardLastFour?: string | null;
  authorizationReference?: string | null;
  otherDescription?: string | null;
  cashDrawerSessionId?: string | null;
};

/** What an idempotency record keeps: everything but the code. */
export type GiftCardSaleResult = {
  saleId: string;
  kind: "ISSUED" | "RELOADED";
  card: StoredGiftCardView;
  amount: string;
  changeAmount: string;
};

export async function sellGiftCard(
  database: Database,
  actor: Actor,
  input: SellGiftCardInput,
): Promise<GiftCardSaleResult & { replayed: boolean; code: string | null }> {
  assertPermission(actor, "gift-cards.view");
  assertPermission(actor, "gift-cards.sell");
  assertPermission(actor, TENDER_PERMISSIONS[input.tenderType]);

  const amount = parseMoney(input.amount, "card amount");
  const isCash = input.tenderType === "CASH";
  const isCard = input.tenderType === "EXTERNAL_CARD";

  if (!isCard && [input.providerName, input.cardBrand, input.cardLastFour, input.authorizationReference].some(Boolean)) {
    throw new BusinessRuleError("CARD_FIELDS_NOT_ALLOWED", "Card details apply to external card payments only.");
  }

  if (isCash && input.externalReference) {
    throw new BusinessRuleError("REFERENCE_NOT_ALLOWED", "Cash has no external reference.");
  }

  if (!isCash && (input.cashDrawerSessionId || input.receivedAmount)) {
    throw new BusinessRuleError("DRAWER_CASH_ONLY", "Only cash goes into a drawer.");
  }

  if (input.tenderType === "OTHER" && !input.otherDescription?.trim()) {
    throw new BusinessRuleError("DESCRIPTION_REQUIRED", "Describe how the guest paid.");
  }

  assertNoCardNumber(input.externalReference, input.providerName, input.cardBrand, input.authorizationReference, input.otherDescription);

  const receivedAmount = isCash ? parseMoney(input.receivedAmount ?? amount, "cash received") : null;
  const changeAmount = receivedAmount ? saleChange(amount, receivedAmount) : "0.00";
  const reloadFingerprint = input.giftCardCode ? codeFingerprint(input.giftCardCode) : null;

  if (input.giftCardCode && !reloadFingerprint) {
    throw giftCardNotFound();
  }

  // Amendment 1: the new code is handed back once, outside what the idempotency record keeps.
  let issuedCode: string | null = null;
  const { idempotencyKey, giftCardCode, ...request } = input;
  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent<GiftCardSaleResult>(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: GIFT_CARD_SALE_SCOPE,
        key: idempotencyKey,
        actorUserId: actor.userId,
        request: { ...request, amount, receivedAmount, reloadFingerprint },
      },
      async (idempotencyRecordId) => {
        // Shares the program row so turning cards off can't race a sale.
        const [program] = await transaction
          .select()
          .from(giftCardPrograms)
          .where(eq(giftCardPrograms.organizationId, actor.organizationId))
          .for("share");

        if (!program?.enabled) {
          throw new BusinessRuleError("GIFT_CARDS_NOT_ENABLED", "Gift cards aren't turned on. A manager can turn them on.");
        }

        const now = new Date();
        let card: GiftCardRow;
        let kind: "ISSUED" | "RELOADED";

        if (giftCardCode) {
          card = await lockGiftCardByCode(transaction, actor, giftCardCode);
          assertCardActive(card);
          kind = "RELOADED";
        } else {
          await transaction
            .insert(giftCardNumberCounters)
            .values({ organizationId: actor.organizationId, lastNumber: 0 })
            .onConflictDoNothing({ target: giftCardNumberCounters.organizationId });

          const [counter] = await transaction
            .update(giftCardNumberCounters)
            .set({ lastNumber: sql`${giftCardNumberCounters.lastNumber} + 1` })
            .where(eq(giftCardNumberCounters.organizationId, actor.organizationId))
            .returning({ lastNumber: giftCardNumberCounters.lastNumber });
          const issued = generateGiftCardCode();
          const [created] = await transaction
            .insert(giftCards)
            .values({
              organizationId: actor.organizationId,
              cardNumber: counter!.lastNumber,
              codeHash: issued.codeHash,
              codeLastFour: issued.lastFour,
              issuedLocationId: actor.locationId,
              issuedByUserId: actor.userId,
              issuedAt: now,
            })
            .returning();

          card = created!;
          kind = "ISSUED";
          issuedCode = issued.code;
        }

        assertSaleWithinLimits(amount, card.balance, program.maxBalance);

        const location = await readOrderLocation(transaction, actor.locationId, now);
        const cashDrawerSessionId = isCash
          ? await resolveCashDrawerSession(transaction, actor, input.cashDrawerSessionId ?? null, location.cashDrawerRequired)
          : null;
        const [sale] = await transaction
          .insert(giftCardSales)
          .values({
            organizationId: actor.organizationId,
            locationId: actor.locationId,
            giftCardId: card.id,
            kind,
            amount,
            tenderType: input.tenderType,
            receivedAmount,
            changeAmount,
            externalReference: input.externalReference?.trim() || null,
            providerName: isCard ? input.providerName?.trim() || null : null,
            cardBrand: isCard ? input.cardBrand?.trim() || null : null,
            cardLastFour: isCard ? input.cardLastFour || null : null,
            authorizationReference: isCard ? input.authorizationReference?.trim() || null : null,
            otherDescription: input.tenderType === "OTHER" ? input.otherDescription!.trim() : null,
            cashDrawerSessionId,
            businessDate: location.businessDate,
            soldByUserId: actor.userId,
            soldAt: now,
            idempotencyRecordId,
          })
          .returning();
        const posted = await postGiftCardEntry(transaction, actor, card, { kind, amount, saleId: sale!.id }, now);

        // Card and provider details, and the code, are not copied into the audit trail.
        await recordAudit(transaction, actor, {
          action: "settlements.gift-card-sold",
          entityId: card.id,
          occurredAt: now,
          after: {
            giftNumber: formatGiftCardNumber(card.cardNumber),
            kind,
            amount,
            tenderType: input.tenderType,
            cashReceived: receivedAmount,
            changeGiven: changeAmount,
            description: sale!.otherDescription,
            balanceAfter: posted.balanceAfter,
            businessDate: location.businessDate,
          },
        });

        return { saleId: sale!.id, kind, card: storedViewOf(card), amount, changeAmount };
      },
    ),
  );

  return { ...outcome.response, replayed: outcome.replayed, code: outcome.replayed ? null : issuedCode };
}

// ------------------------------------------------------------------------------ Look up, history

/** Finds a card by its code (any view holder) or its public number (managers only). */
export async function lookUpGiftCard(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { code?: string | null; cardNumber?: string | null },
): Promise<GiftCardView> {
  assertPermission(actor, "gift-cards.view");

  let cardId: string | null = null;

  if (input.code) {
    cardId = await findGiftCardIdByCode(executor, actor.organizationId, input.code);

    if (!cardId) {
      throw giftCardNotFound();
    }
  } else if (input.cardNumber) {
    assertPermission(actor, "gift-cards.manage");

    const number = parseGiftCardNumber(input.cardNumber);
    const [row] = number
      ? await executor
          .select({ id: giftCards.id })
          .from(giftCards)
          .where(and(eq(giftCards.organizationId, actor.organizationId), eq(giftCards.cardNumber, number)))
      : [];

    if (!row) {
      throw new NotFoundError("gift card");
    }

    cardId = row.id;
  } else {
    throw new BusinessRuleError("CODE_REQUIRED", "Enter the card's code.");
  }

  const [card] = await executor.select().from(giftCards).where(eq(giftCards.id, cardId));

  return viewOf(card!);
}

export type GiftCardHistory = {
  card: GiftCardView;
  entries: {
    id: string;
    kind: string;
    amount: string;
    balanceAfter: string;
    businessDate: string;
    locationId: string;
    reason: string | null;
    occurredAt: string;
  }[];
  sales: {
    id: string;
    kind: string;
    amount: string;
    tenderType: string;
    status: string;
    businessDate: string;
    locationId: string;
    soldAt: string;
    version: number;
  }[];
};

export async function getGiftCardHistory(executor: DatabaseExecutor, actor: Actor, cardId: string): Promise<GiftCardHistory> {
  assertPermission(actor, "gift-cards.view");

  const [card] = await executor
    .select()
    .from(giftCards)
    .where(and(eq(giftCards.id, cardId), eq(giftCards.organizationId, actor.organizationId)));

  if (!card) {
    throw new NotFoundError("gift card");
  }

  const [entries, sales] = await Promise.all([
    executor
      .select()
      .from(giftCardEntries)
      .where(eq(giftCardEntries.giftCardId, cardId))
      .orderBy(desc(giftCardEntries.sequence))
      .limit(200),
    executor.select().from(giftCardSales).where(eq(giftCardSales.giftCardId, cardId)).orderBy(asc(giftCardSales.soldAt)),
  ]);

  return {
    card: viewOf(card),
    entries: entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      amount: entry.amount,
      balanceAfter: entry.balanceAfter,
      businessDate: entry.businessDate,
      locationId: entry.locationId,
      reason: entry.reason,
      occurredAt: entry.occurredAt.toISOString(),
    })),
    sales: sales.map((sale) => ({
      id: sale.id,
      kind: sale.kind,
      amount: sale.amount,
      tenderType: sale.tenderType,
      status: sale.status,
      businessDate: sale.businessDate,
      locationId: sale.locationId,
      soldAt: sale.soldAt.toISOString(),
      version: sale.version,
    })),
  };
}

/** The most recent cards, for managers. */
export async function listGiftCards(executor: DatabaseExecutor, actor: Actor, limit = 50): Promise<GiftCardView[]> {
  assertPermission(actor, "gift-cards.manage");

  const rows = await executor
    .select()
    .from(giftCards)
    .where(eq(giftCards.organizationId, actor.organizationId))
    .orderBy(desc(giftCards.cardNumber))
    .limit(limit);

  return rows.map(viewOf);
}

// ------------------------------------------------------------------------- Sale void (policy 11)

export async function voidGiftCardSale(
  database: Database,
  actor: Actor,
  saleId: string,
  input: { expectedVersion: number; reason: string },
): Promise<GiftCardView> {
  assertPermission(actor, "gift-cards.view");
  assertPermission(actor, "gift-cards.manage");

  const reason = requiredReason(input.reason);

  return withTransaction(database, async (transaction) => {
    const [found] = await transaction
      .select({ giftCardId: giftCardSales.giftCardId })
      .from(giftCardSales)
      .where(
        and(
          eq(giftCardSales.id, saleId),
          eq(giftCardSales.organizationId, actor.organizationId),
          eq(giftCardSales.locationId, actor.locationId),
        ),
      );

    if (!found) {
      throw new NotFoundError("gift card sale");
    }

    // Card first, then the sale: the same order as selling.
    const card = await lockGiftCard(transaction, actor, found.giftCardId);
    const [sale] = await transaction.select().from(giftCardSales).where(eq(giftCardSales.id, saleId)).for("update");

    if (sale!.version !== input.expectedVersion) {
      throw new ConcurrencyError("gift card sale", saleId);
    }

    if (sale!.status !== "RECORDED") {
      throw new BusinessRuleError("SALE_NOT_VOIDABLE", "That sale is already voided.");
    }

    if (compareDecimals(card.balance, sale!.amount) < 0) {
      throw new BusinessRuleError(
        "GIFT_CARD_SALE_SPENT",
        "Some of this card's value has been spent, so its sale can't be voided.",
        { balance: card.balance },
      );
    }

    if (sale!.cashDrawerSessionId) {
      await resolveCashDrawerSession(transaction, actor, sale!.cashDrawerSessionId, true);
    }

    const now = new Date();
    const location = await readOrderLocation(transaction, actor.locationId, now);

    await transaction
      .update(giftCardSales)
      .set({
        status: "VOIDED",
        voidedAt: now,
        voidedByUserId: actor.userId,
        voidReason: reason,
        voidedBusinessDate: location.businessDate,
        updatedAt: now,
        version: sql`${giftCardSales.version} + 1`,
      })
      .where(eq(giftCardSales.id, saleId));

    const posted = await postGiftCardEntry(
      transaction,
      actor,
      card,
      { kind: "SALE_VOIDED", amount: toScale(subtractDecimals("0", sale!.amount), 2), saleId, reason },
      now,
    );

    await recordAudit(transaction, actor, {
      action: "settlements.gift-card-sale-voided",
      entityId: card.id,
      occurredAt: now,
      before: { status: "RECORDED" },
      after: {
        giftNumber: formatGiftCardNumber(card.cardNumber),
        kind: sale!.kind,
        amount: sale!.amount,
        tenderType: sale!.tenderType,
        status: "VOIDED",
        reason,
        balanceAfter: posted.balanceAfter,
      },
    });

    return viewOf(card);
  });
}

// --------------------------------------------------------- Cash-out, adjustments, status (policy 12)

export async function cashOutGiftCard(
  database: Database,
  actor: Actor,
  cardId: string,
  input: { idempotencyKey: string; expectedVersion: number; reason: string; cashDrawerSessionId?: string | null },
): Promise<{ card: StoredGiftCardView; amount: string; replayed: boolean }> {
  assertPermission(actor, "gift-cards.view");
  assertPermission(actor, "gift-cards.manage");
  assertPermission(actor, "settlements.tender.cash");

  const reason = requiredReason(input.reason);
  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent<{ card: StoredGiftCardView; amount: string }>(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: GIFT_CARD_CASH_OUT_SCOPE,
        key: input.idempotencyKey,
        actorUserId: actor.userId,
        request: { cardId, expectedVersion: input.expectedVersion, reason, cashDrawerSessionId: input.cashDrawerSessionId ?? null },
      },
      async () => {
        const card = await lockGiftCard(transaction, actor, cardId);

        if (card.version !== input.expectedVersion) {
          throw new ConcurrencyError("gift card", cardId);
        }

        assertCardActive(card);

        const amount = assertCanCashOut(card.balance);
        const now = new Date();
        const location = await readOrderLocation(transaction, actor.locationId, now);
        const cashDrawerSessionId = await resolveCashDrawerSession(
          transaction,
          actor,
          input.cashDrawerSessionId ?? null,
          location.cashDrawerRequired,
        );
        const posted = await postGiftCardEntry(
          transaction,
          actor,
          card,
          { kind: "CASHED_OUT", amount: toScale(subtractDecimals("0", amount), 2), cashDrawerSessionId, reason },
          now,
        );

        await recordAudit(transaction, actor, {
          action: "settlements.gift-card-cashed-out",
          entityId: card.id,
          occurredAt: now,
          after: { giftNumber: formatGiftCardNumber(card.cardNumber), amount, reason, balanceAfter: posted.balanceAfter },
        });

        return { card: storedViewOf(card), amount };
      },
    ),
  );

  return { ...outcome.response, replayed: outcome.replayed };
}

export async function adjustGiftCard(
  database: Database,
  actor: Actor,
  cardId: string,
  input: { amount: string; reason: string; expectedVersion: number },
): Promise<GiftCardView> {
  assertPermission(actor, "gift-cards.view");
  assertPermission(actor, "gift-cards.manage");

  const amount = parseSignedMoney(input.amount);
  const reason = requiredReason(input.reason);

  return withTransaction(database, async (transaction) => {
    const card = await lockGiftCard(transaction, actor, cardId);

    if (card.version !== input.expectedVersion) {
      throw new ConcurrencyError("gift card", cardId);
    }

    assertCardActive(card);

    const program = await assertProgramEnabled(transaction, actor);

    assertAdjustmentWithinLimits(amount, card.balance, program.maxBalance);

    const now = new Date();
    const posted = await postGiftCardEntry(transaction, actor, card, { kind: "ADJUSTED", amount, reason }, now);

    await recordAudit(transaction, actor, {
      action: "settlements.gift-card-adjusted",
      entityId: card.id,
      occurredAt: now,
      after: { giftNumber: formatGiftCardNumber(card.cardNumber), amount, reason, balanceAfter: posted.balanceAfter },
    });

    return viewOf(card);
  });
}

export async function setGiftCardStatus(
  database: Database,
  actor: Actor,
  cardId: string,
  input: { status: "ACTIVE" | "INACTIVE"; reason: string; expectedVersion: number },
): Promise<GiftCardView> {
  assertPermission(actor, "gift-cards.view");
  assertPermission(actor, "gift-cards.manage");

  const reason = requiredReason(input.reason);

  return withTransaction(database, async (transaction) => {
    const card = await lockGiftCard(transaction, actor, cardId);

    if (card.version !== input.expectedVersion) {
      throw new ConcurrencyError("gift card", cardId);
    }

    if (card.status === input.status) {
      throw new BusinessRuleError("GIFT_CARD_STATUS_UNCHANGED", `This card is already ${input.status.toLowerCase()}.`);
    }

    const now = new Date();
    const [updated] = await transaction
      .update(giftCards)
      .set({ status: input.status, statusReason: reason, updatedAt: now, version: sql`${giftCards.version} + 1` })
      .where(eq(giftCards.id, cardId))
      .returning();

    await recordAudit(transaction, actor, {
      action: "settlements.gift-card-status-changed",
      entityId: card.id,
      occurredAt: now,
      before: { status: card.status },
      after: { giftNumber: formatGiftCardNumber(card.cardNumber), status: input.status, reason },
    });

    return viewOf(updated!);
  });
}

/** A lost or stolen card keeps its balance and history under a new code, shown once. */
export async function replaceGiftCardCode(
  database: Database,
  actor: Actor,
  cardId: string,
  input: { reason: string; expectedVersion: number },
): Promise<{ card: GiftCardView; code: string }> {
  assertPermission(actor, "gift-cards.view");
  assertPermission(actor, "gift-cards.manage");

  const reason = requiredReason(input.reason);

  return withTransaction(database, async (transaction) => {
    const card = await lockGiftCard(transaction, actor, cardId);

    if (card.version !== input.expectedVersion) {
      throw new ConcurrencyError("gift card", cardId);
    }

    const issued = generateGiftCardCode();
    const now = new Date();
    const [updated] = await transaction
      .update(giftCards)
      .set({
        codeHash: issued.codeHash,
        codeLastFour: issued.lastFour,
        codeReplacedAt: now,
        updatedAt: now,
        version: sql`${giftCards.version} + 1`,
      })
      .where(eq(giftCards.id, cardId))
      .returning();

    await recordAudit(transaction, actor, {
      action: "settlements.gift-card-code-replaced",
      entityId: card.id,
      occurredAt: now,
      after: { giftNumber: formatGiftCardNumber(card.cardNumber), reason },
    });

    return { card: viewOf(updated!), code: issued.code };
  });
}
