import { and, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";

import type { Database } from "@/db";
import { giftCardPurchasers, giftCards } from "@/db/schema";
import { withTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import { recordAudit, recordFreeTextRedaction } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { formatGiftCardNumber } from "../rules/gift-card-code";
import { looksLikeCardNumber } from "../rules/settlement-math";
import { assertPermission } from "./access";

// Phase 34 (policies 3–4): who bought a card, kept only for an unclaimed-property filing.
// Optional, entered at issue by the seller, read and changed only with
// `gift-cards.purchaser.view`. Values never reach audit rows (field names only), logs, outbox
// events, idempotency records or receipts. Cleared, never deleted.

export const PURCHASER_FIELDS = [
  "name",
  "email",
  "phone",
  "addressLine1",
  "addressLine2",
  "city",
  "region",
  "postalCode",
  "country",
] as const;

export type PurchaserField = (typeof PURCHASER_FIELDS)[number];
export type PurchaserInput = Partial<Record<PurchaserField, string | null>>;
export type PurchaserDetails = Record<PurchaserField, string | null>;

const MAX_LENGTH: Record<PurchaserField, number> = {
  name: 120,
  email: 254,
  phone: 40,
  addressLine1: 120,
  addressLine2: 120,
  city: 80,
  region: 80,
  postalCode: 20,
  country: 60,
};

const LABEL: Record<PurchaserField, string> = {
  name: "name",
  email: "email",
  phone: "phone",
  addressLine1: "address line 1",
  addressLine2: "address line 2",
  city: "city",
  region: "state or region",
  postalCode: "postal code",
  country: "country",
};

/** The trimmed details, or null when nothing was given. Refuses long values and card numbers. */
export function normalizePurchaser(input: PurchaserInput | null | undefined): PurchaserDetails | null {
  if (!input) {
    return null;
  }

  const details = {} as PurchaserDetails;

  for (const field of PURCHASER_FIELDS) {
    const value = input[field]?.trim() || null;

    if (value && value.length > MAX_LENGTH[field]) {
      throw new BusinessRuleError("PURCHASER_FIELD_TOO_LONG", `The purchaser's ${LABEL[field]} is up to ${MAX_LENGTH[field]} characters.`);
    }

    if (value && looksLikeCardNumber(value)) {
      throw new BusinessRuleError("CARD_DATA_REFUSED", "Don't enter card numbers.");
    }

    details[field] = value;
  }

  return PURCHASER_FIELDS.some((field) => details[field]) ? details : null;
}

const filled = (details: PurchaserDetails) => PURCHASER_FIELDS.filter((field) => details[field]);

/** Policy 3: stores the details given at issue, in the sale's transaction. */
export async function recordPurchaserInTransaction(
  transaction: DatabaseTransaction,
  actor: Actor,
  card: { id: string; cardNumber: number },
  details: PurchaserDetails,
  at: Date,
): Promise<void> {
  await transaction.insert(giftCardPurchasers).values({
    giftCardId: card.id,
    organizationId: actor.organizationId,
    ...details,
    createdByUserId: actor.userId,
    createdAt: at,
    updatedAt: at,
  });
  await recordAudit(transaction, actor, {
    action: "settlements.gift-card-purchaser-changed",
    entityId: card.id,
    occurredAt: at,
    after: { giftNumber: formatGiftCardNumber(card.cardNumber), change: "ADDED", fields: filled(details) },
  });
}

export type PurchaserView = PurchaserDetails & { cleared: boolean; version: number | null };

function assertCanRead(actor: Actor) {
  assertPermission(actor, "gift-cards.view");
  assertPermission(actor, "gift-cards.purchaser.view");
}

async function readCard(executor: DatabaseExecutor, actor: Actor, cardId: string) {
  const [card] = await executor
    .select({ id: giftCards.id, cardNumber: giftCards.cardNumber })
    .from(giftCards)
    .where(and(eq(giftCards.id, cardId), eq(giftCards.organizationId, actor.organizationId)));

  if (!card) {
    throw new NotFoundError("gift card");
  }

  return card;
}

const EMPTY: PurchaserDetails = Object.fromEntries(PURCHASER_FIELDS.map((field) => [field, null])) as PurchaserDetails;

/** Policy 4: a card's purchaser details, for holders of `gift-cards.purchaser.view`. */
export async function getPurchaser(executor: DatabaseExecutor, actor: Actor, cardId: string): Promise<PurchaserView> {
  assertCanRead(actor);
  await readCard(executor, actor, cardId);

  const [row] = await executor.select().from(giftCardPurchasers).where(eq(giftCardPurchasers.giftCardId, cardId));

  if (!row) {
    return { ...EMPTY, cleared: false, version: null };
  }

  const details = Object.fromEntries(PURCHASER_FIELDS.map((field) => [field, row[field]])) as PurchaserDetails;

  return { ...details, cleared: row.clearedAt !== null, version: row.version };
}

/** Policy 3: adds or changes a card's purchaser details (`gift-cards.manage`). */
export async function savePurchaser(
  database: Database,
  actor: Actor,
  cardId: string,
  input: { details: PurchaserInput; expectedVersion: number | null },
): Promise<PurchaserView> {
  assertCanRead(actor);
  assertPermission(actor, "gift-cards.manage");

  const details = normalizePurchaser(input.details);

  if (!details) {
    throw new BusinessRuleError("PURCHASER_EMPTY", "Enter at least one detail, or clear the details instead.");
  }

  await withTransaction(database, async (transaction) => {
    const card = await readCard(transaction, actor, cardId);
    const [row] = await transaction.select().from(giftCardPurchasers).where(eq(giftCardPurchasers.giftCardId, cardId)).for("update");
    const now = new Date();

    if (!row) {
      if (input.expectedVersion !== null) {
        throw new ConcurrencyError("gift card purchaser", cardId);
      }

      await recordPurchaserInTransaction(transaction, actor, card, details, now);

      return;
    }

    if (row.version !== input.expectedVersion) {
      throw new ConcurrencyError("gift card purchaser", cardId);
    }

    if (row.clearedAt) {
      throw new BusinessRuleError("PURCHASER_CLEARED", "These purchaser details were cleared and can't be entered again.");
    }

    const changed = PURCHASER_FIELDS.filter((field) => row[field] !== details[field]);

    if (changed.length === 0) {
      return;
    }

    await transaction
      .update(giftCardPurchasers)
      .set({ ...details, updatedByUserId: actor.userId, updatedAt: now, version: sql`${giftCardPurchasers.version} + 1` })
      .where(eq(giftCardPurchasers.giftCardId, cardId));
    await recordAudit(transaction, actor, {
      action: "settlements.gift-card-purchaser-changed",
      entityId: card.id,
      occurredAt: now,
      after: { giftNumber: formatGiftCardNumber(card.cardNumber), change: "CHANGED", fields: changed },
    });
  });

  return getPurchaser(database, actor, cardId);
}

/** Empties every field for good. The caller has locked nothing else; audit is the caller's. */
async function clearRow(transaction: DatabaseTransaction, actor: Actor, cardId: string, at: Date) {
  await transaction
    .update(giftCardPurchasers)
    .set({ ...EMPTY, clearedAt: at, updatedByUserId: actor.userId, updatedAt: at, version: sql`${giftCardPurchasers.version} + 1` })
    .where(eq(giftCardPurchasers.giftCardId, cardId));
}

/** Policy 4: "Clear purchaser details", for good (`gift-cards.manage` + `gift-cards.purchaser.view`). */
export async function clearPurchaser(
  database: Database,
  actor: Actor,
  cardId: string,
  input: { expectedVersion: number },
): Promise<PurchaserView> {
  assertCanRead(actor);
  assertPermission(actor, "gift-cards.manage");

  await withTransaction(database, async (transaction) => {
    const card = await readCard(transaction, actor, cardId);
    const [row] = await transaction.select().from(giftCardPurchasers).where(eq(giftCardPurchasers.giftCardId, cardId)).for("update");

    if (!row || row.clearedAt) {
      throw new BusinessRuleError("PURCHASER_NONE", "This card has no purchaser details to clear.");
    }

    if (row.version !== input.expectedVersion) {
      throw new ConcurrencyError("gift card purchaser", cardId);
    }

    const now = new Date();

    await clearRow(transaction, actor, cardId, now);
    await recordAudit(transaction, actor, {
      action: "settlements.gift-card-purchaser-changed",
      entityId: card.id,
      occurredAt: now,
      after: { giftNumber: formatGiftCardNumber(card.cardNumber), change: "CLEARED", fields: PURCHASER_FIELDS.filter((field) => row[field]) },
    });
  });

  return getPurchaser(database, actor, cardId);
}

// ------------------------------------------------------------------- Guest erase (policy 11)

export type PurchaserCandidate = { id: string; cardNumber: string; text: string };

/**
 * Policy 11: purchaser rows that may mention someone, organization-wide: any field containing
 * one of the words (any case), or whose phone digits contain one of the digit runs. A first
 * pass only; the erase workflow decides what is a mention.
 */
export async function findPurchaserCandidates(
  executor: DatabaseExecutor,
  actor: Actor,
  query: { words: readonly string[]; digitRuns: readonly string[]; contains: (word: string) => string },
): Promise<PurchaserCandidate[]> {
  if (query.words.length + query.digitRuns.length === 0) {
    return [];
  }

  const columns = [giftCardPurchasers.name, giftCardPurchasers.email, giftCardPurchasers.phone, giftCardPurchasers.addressLine1];
  const matching: SQL = or(
    ...query.words.flatMap((word) => columns.map((column) => ilike(column, query.contains(word)))),
    ...query.digitRuns.map((digits) => sql`regexp_replace(coalesce(${giftCardPurchasers.phone}, ''), '[^0-9]', '', 'g') LIKE ${query.contains(digits)}`),
  )!;
  const rows = await executor
    .select({ purchaser: giftCardPurchasers, cardNumber: giftCards.cardNumber })
    .from(giftCardPurchasers)
    .innerJoin(giftCards, eq(giftCards.id, giftCardPurchasers.giftCardId))
    .where(and(eq(giftCardPurchasers.organizationId, actor.organizationId), isNull(giftCardPurchasers.clearedAt), matching));

  return rows.map(({ purchaser, cardNumber }) => ({
    id: purchaser.giftCardId,
    cardNumber: formatGiftCardNumber(cardNumber),
    text: [purchaser.name, purchaser.email, purchaser.phone, purchaser.addressLine1].filter(Boolean).join(" · "),
  }));
}

/** Policy 12: a purchaser match clears the whole row, with a redaction record per field. */
export async function clearPurchaserForErase(
  transaction: DatabaseTransaction,
  actor: Actor,
  cardId: string,
  reason: string,
): Promise<void> {
  const [row] = await transaction
    .select()
    .from(giftCardPurchasers)
    .where(and(eq(giftCardPurchasers.giftCardId, cardId), eq(giftCardPurchasers.organizationId, actor.organizationId)))
    .for("update");

  if (!row || row.clearedAt) {
    return;
  }

  const columns: Record<PurchaserField, string> = {
    name: "name",
    email: "email",
    phone: "phone",
    addressLine1: "address_line1",
    addressLine2: "address_line2",
    city: "city",
    region: "region",
    postalCode: "postal_code",
    country: "country",
  };

  for (const field of PURCHASER_FIELDS.filter((name) => row[name])) {
    await recordFreeTextRedaction(transaction, actor, { tableName: "gift_card_purchasers", rowId: cardId, columnName: columns[field], reason });
  }

  await clearRow(transaction, actor, cardId, new Date());
}
