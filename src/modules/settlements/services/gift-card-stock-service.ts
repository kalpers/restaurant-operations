import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { getGiftCardCodeKey } from "@/config/gift-card-env";
import type { Database } from "@/db";
import { giftCardNumberCounters, giftCardStockBatches, giftCards } from "@/db/schema";
import { readConstraintName } from "@/db/helpers/database-errors";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { formatGiftCardNumber } from "../rules/gift-card-code";
import { formatStockBatchNumber, MAX_STOCK_BATCH, parseStockList, type StockLineProblem } from "../rules/gift-card-stock";
import { looksLikeCardNumber } from "../rules/settlement-math";
import { assertPermission } from "./access";
import { readGiftCardProgram } from "./gift-card-ledger";

// Phase 34 (policies 7–10): supplier cards registered as stock before sale. A batch is
// registered all or nothing; its codes are kept only as each card's hash and last four, and
// the pasted list is never stored, logged, audited or kept in an idempotency record. Stock
// holds no value: it is sold through `sellGiftCard` and can be deactivated, never deleted.

export const GIFT_CARD_STOCK_SCOPE = "gift-cards.stock";

const PROBLEM_TEXT: Record<StockLineProblem, string> = {
  INVALID_CODE: "isn't a code (8 to 24 letters and digits)",
  LOOKS_LIKE_CARD_NUMBER: "looks like a payment card number",
  DUPLICATE_IN_BATCH: "repeats an earlier line",
  INVALID_SERIAL: "has a printed serial that is too long or looks like a card number",
  TOO_MANY_FIELDS: "has more than a serial and a code",
};

function describeLines(lines: readonly number[]): string {
  const shown = lines.slice(0, 10).join(", ");

  return lines.length > 10 ? `${shown} and ${lines.length - 10} more` : shown;
}

function linesRefusal(problems: readonly { line: number; problem: StockLineProblem }[]): BusinessRuleError {
  const groups = new Map<StockLineProblem, number[]>();

  for (const { line, problem } of problems) {
    groups.set(problem, [...(groups.get(problem) ?? []), line]);
  }

  const parts = [...groups].map(([problem, lines]) => `line${lines.length === 1 ? "" : "s"} ${describeLines(lines)} ${PROBLEM_TEXT[problem]}`);

  return new BusinessRuleError("STOCK_LIST_INVALID", `Nothing was registered: ${parts.join("; ")}.`, {
    problems: problems.slice(0, 200),
  });
}

export type StockBatchResult = {
  batchId: string;
  batchNumber: string;
  cardCount: number;
  firstCard: string;
  lastCard: string;
};

/** Policies 7–8: registers a box of supplier cards as stock, all or nothing. */
export async function registerStockBatch(
  database: Database,
  actor: Actor,
  input: { idempotencyKey: string; description: string; lines: readonly string[] },
): Promise<StockBatchResult & { replayed: boolean }> {
  assertPermission(actor, "gift-cards.view");
  assertPermission(actor, "gift-cards.manage");

  const description = input.description.trim();

  if (!description || description.length > 80) {
    throw new BusinessRuleError("DESCRIPTION_REQUIRED", "Describe the batch (supplier or box), up to 80 characters.");
  }

  if (looksLikeCardNumber(description)) {
    throw new BusinessRuleError("CARD_DATA_REFUSED", "Don't enter card numbers.");
  }

  if (input.lines.length > MAX_STOCK_BATCH * 2) {
    throw new BusinessRuleError("STOCK_LIST_TOO_LONG", `A batch is up to ${MAX_STOCK_BATCH} cards.`);
  }

  const parsed = parseStockList(input.lines, getGiftCardCodeKey());

  if (!parsed.ok) {
    if (parsed.reason === "LINES") {
      throw linesRefusal(parsed.problems);
    }

    throw parsed.reason === "EMPTY"
      ? new BusinessRuleError("STOCK_LIST_EMPTY", "Enter at least one code.")
      : new BusinessRuleError("STOCK_LIST_TOO_LONG", `A batch is up to ${MAX_STOCK_BATCH} cards.`);
  }

  const cards = parsed.cards;

  try {
    const outcome = await withTransaction(database, (transaction) =>
      runIdempotent<StockBatchResult>(
        transaction,
        {
          organizationId: actor.organizationId,
          scope: GIFT_CARD_STOCK_SCOPE,
          key: input.idempotencyKey,
          actorUserId: actor.userId,
          // Hashes only: the codes are never kept.
          request: { description, cards: cards.map((card) => [card.serial, card.codeHash]) },
        },
        async (idempotencyRecordId) => {
          const program = await readGiftCardProgram(transaction, actor.organizationId);

          if (!program.enabled) {
            throw new BusinessRuleError("GIFT_CARDS_NOT_ENABLED", "Gift cards aren't turned on. A manager can turn them on.");
          }

          // Phase 35 (policy 5): a code is taken in either stored form.
          const existing = await transaction
            .select({ codeHash: giftCards.codeHash })
            .from(giftCards)
            .where(
              or(
                and(
                  eq(giftCards.codeHashScheme, "HMAC_SHA256"),
                  inArray(giftCards.codeHash, cards.map((card) => card.codeHash)),
                ),
                and(
                  eq(giftCards.codeHashScheme, "SHA256"),
                  inArray(giftCards.codeHash, cards.map((card) => card.legacyCodeHash)),
                ),
              ),
            );

          if (existing.length > 0) {
            const taken = new Set(existing.map((row) => row.codeHash));
            const takenLines = cards.filter((card) => taken.has(card.codeHash) || taken.has(card.legacyCodeHash)).map((card) => card.line);

            throw new ConflictError(
              "GIFT_CARD_CODE_IN_USE",
              `Nothing was registered: line${takenLines.length === 1 ? "" : "s"} ${describeLines(takenLines)} ${
                takenLines.length === 1 ? "is" : "are"
              } already on a gift card.`,
            );
          }

          await transaction
            .insert(giftCardNumberCounters)
            .values({ organizationId: actor.organizationId, lastNumber: 0 })
            .onConflictDoNothing({ target: giftCardNumberCounters.organizationId });

          const [counter] = await transaction
            .update(giftCardNumberCounters)
            .set({
              lastNumber: sql`${giftCardNumberCounters.lastNumber} + ${cards.length}`,
              lastBatchNumber: sql`${giftCardNumberCounters.lastBatchNumber} + 1`,
            })
            .where(eq(giftCardNumberCounters.organizationId, actor.organizationId))
            .returning();
          const firstNumber = counter!.lastNumber - cards.length + 1;
          const now = new Date();
          const [batch] = await transaction
            .insert(giftCardStockBatches)
            .values({
              organizationId: actor.organizationId,
              batchNumber: counter!.lastBatchNumber,
              locationId: actor.locationId,
              description,
              cardCount: cards.length,
              registeredByUserId: actor.userId,
              registeredAt: now,
              idempotencyRecordId,
            })
            .returning();

          for (let start = 0; start < cards.length; start += 250) {
            await transaction.insert(giftCards).values(
              cards.slice(start, start + 250).map((card, offset) => ({
                organizationId: actor.organizationId,
                cardNumber: firstNumber + start + offset,
                codeHash: card.codeHash,
                codeHashScheme: "HMAC_SHA256",
                codeLastFour: card.lastFour,
                codeSource: "SUPPLIER",
                status: "STOCK",
                stockBatchId: batch!.id,
                printedSerial: card.serial,
              })),
            );
          }

          const result: StockBatchResult = {
            batchId: batch!.id,
            batchNumber: formatStockBatchNumber(batch!.batchNumber),
            cardCount: cards.length,
            firstCard: formatGiftCardNumber(firstNumber),
            lastCard: formatGiftCardNumber(counter!.lastNumber),
          };

          await recordAudit(transaction, actor, {
            action: "settlements.gift-card-stock-registered",
            entityId: batch!.id,
            occurredAt: now,
            after: { batchNumber: result.batchNumber, cardsRegistered: cards.length, description, firstGiftNumber: result.firstCard, lastGiftNumber: result.lastCard },
          });

          return result;
        },
      ),
    );

    return { ...outcome.response, replayed: outcome.replayed };
  } catch (error) {
    // Two batches racing for one code: the unique index decides.
    if (readConstraintName(error) === "gift_cards_code_hash_unique") {
      throw new ConflictError("GIFT_CARD_CODE_IN_USE", "Nothing was registered: a code in the list is already on a gift card.");
    }

    throw error;
  }
}

export type StockBatchView = {
  id: string;
  batchNumber: string;
  description: string;
  locationId: string;
  cardCount: number;
  inStock: number;
  sold: number;
  deactivated: number;
  registeredAt: string;
};

/** Policy 10: the "Card stock" panel, newest batch first. */
export async function listStockBatches(executor: DatabaseExecutor, actor: Actor, limit = 50): Promise<StockBatchView[]> {
  assertPermission(actor, "gift-cards.manage");

  const rows = await executor
    .select({
      id: giftCardStockBatches.id,
      batchNumber: giftCardStockBatches.batchNumber,
      description: giftCardStockBatches.description,
      locationId: giftCardStockBatches.locationId,
      cardCount: giftCardStockBatches.cardCount,
      registeredAt: giftCardStockBatches.registeredAt,
      inStock: sql<number>`COUNT(${giftCards.id}) FILTER (WHERE ${giftCards.status} = 'STOCK')::int`,
      sold: sql<number>`COUNT(${giftCards.id}) FILTER (WHERE ${giftCards.issuedAt} IS NOT NULL)::int`,
      deactivated: sql<number>`COUNT(${giftCards.id}) FILTER (WHERE ${giftCards.issuedAt} IS NULL AND ${giftCards.status} = 'INACTIVE')::int`,
    })
    .from(giftCardStockBatches)
    .leftJoin(giftCards, eq(giftCards.stockBatchId, giftCardStockBatches.id))
    .where(eq(giftCardStockBatches.organizationId, actor.organizationId))
    .groupBy(giftCardStockBatches.id)
    .orderBy(desc(giftCardStockBatches.batchNumber))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    batchNumber: formatStockBatchNumber(row.batchNumber),
    description: row.description,
    locationId: row.locationId,
    cardCount: row.cardCount,
    inStock: row.inStock,
    sold: row.sold,
    deactivated: row.deactivated,
    registeredAt: row.registeredAt.toISOString(),
  }));
}

export type StockCardView = {
  id: string;
  cardNumber: string;
  lastFour: string;
  printedSerial: string | null;
  status: string;
  sold: boolean;
  version: number;
};

/** The cards of one batch, for deactivating a single lost card. */
export async function listStockBatchCards(executor: DatabaseExecutor, actor: Actor, batchId: string): Promise<StockCardView[]> {
  assertPermission(actor, "gift-cards.manage");

  const [batch] = await executor
    .select({ id: giftCardStockBatches.id })
    .from(giftCardStockBatches)
    .where(and(eq(giftCardStockBatches.id, batchId), eq(giftCardStockBatches.organizationId, actor.organizationId)));

  if (!batch) {
    throw new NotFoundError("gift card stock batch");
  }

  const rows = await executor.select().from(giftCards).where(eq(giftCards.stockBatchId, batchId)).orderBy(asc(giftCards.cardNumber));

  return rows.map((card) => ({
    id: card.id,
    cardNumber: formatGiftCardNumber(card.cardNumber),
    lastFour: card.codeLastFour,
    printedSerial: card.printedSerial,
    status: card.status,
    sold: card.issuedAt !== null,
    version: card.version,
  }));
}

/**
 * Policy 10: deactivates unsold stock, one card or everything left in a batch. A stock card
 * holds nothing, so there is no ledger entry; it stays, inactive, with its reason.
 */
export async function deactivateStock(
  database: Database,
  actor: Actor,
  batchId: string,
  input: { reason: string; cardId?: string | null; expectedVersion?: number | null },
): Promise<{ deactivated: number }> {
  assertPermission(actor, "gift-cards.view");
  assertPermission(actor, "gift-cards.manage");

  const reason = input.reason.trim();

  if (!reason || reason.length > 200) {
    throw new BusinessRuleError("REASON_REQUIRED", "Give a reason of up to 200 characters.");
  }

  if (looksLikeCardNumber(reason)) {
    throw new BusinessRuleError("CARD_DATA_REFUSED", "Don't enter card numbers.");
  }

  return withTransaction(database, async (transaction) => {
    const [batch] = await transaction
      .select()
      .from(giftCardStockBatches)
      .where(and(eq(giftCardStockBatches.id, batchId), eq(giftCardStockBatches.organizationId, actor.organizationId)));

    if (!batch) {
      throw new NotFoundError("gift card stock batch");
    }

    const conditions = [eq(giftCards.stockBatchId, batchId), eq(giftCards.status, "STOCK"), isNull(giftCards.issuedAt)];

    if (input.cardId) {
      const [card] = await transaction
        .select()
        .from(giftCards)
        .where(and(eq(giftCards.id, input.cardId), eq(giftCards.stockBatchId, batchId)))
        .for("update");

      if (!card) {
        throw new NotFoundError("gift card");
      }

      if (input.expectedVersion != null && card.version !== input.expectedVersion) {
        throw new ConcurrencyError("gift card", card.id);
      }

      if (card.status !== "STOCK") {
        throw new BusinessRuleError("GIFT_CARD_NOT_IN_STOCK", `${formatGiftCardNumber(card.cardNumber)} isn't unsold stock.`);
      }

      conditions.push(eq(giftCards.id, input.cardId));
    }

    const now = new Date();
    const updated = await transaction
      .update(giftCards)
      .set({ status: "INACTIVE", statusReason: reason, updatedAt: now, version: sql`${giftCards.version} + 1` })
      .where(and(...conditions))
      .returning({ id: giftCards.id });

    if (updated.length === 0) {
      throw new BusinessRuleError("GIFT_CARD_NOT_IN_STOCK", "Nothing in this batch is left in stock.");
    }

    await recordAudit(transaction, actor, {
      action: "settlements.gift-card-stock-deactivated",
      entityId: batch.id,
      occurredAt: now,
      after: { batchNumber: formatStockBatchNumber(batch.batchNumber), cardsDeactivated: updated.length, reason },
    });

    return { deactivated: updated.length };
  });
}
