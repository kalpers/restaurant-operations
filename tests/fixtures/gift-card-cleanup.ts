import { sql } from "drizzle-orm";

import {
  giftCardEntries,
  giftCardEscheatments,
  giftCardNumberCounters,
  giftCardPrograms,
  giftCardPurchasers,
  giftCards,
  giftCardSales,
  giftCardStockBatches,
} from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";

const GUARDED = [
  ["gift_card_entries", "gift_card_entries_guard"],
  ["gift_cards", "gift_cards_guard"],
  ["gift_card_sales", "gift_card_sales_guard"],
  // Phase 34: purchasers, unclaimed reports and stock batches.
  ["gift_card_purchasers", "gift_card_purchasers_guard_trigger"],
  ["gift_card_escheatments", "gift_card_escheatments_append_only_trigger"],
  ["gift_card_stock_batches", "gift_card_stock_batches_append_only_trigger"],
] as const;

/**
 * Phase 31: every gift card row. The ledger, cards and sales are guarded, so the guards are
 * lifted for the caller's transaction only (test database). Card rows point at tenders,
 * refunds, drawer sessions and idempotency records, so this runs before those are cleared.
 */
export async function clearGiftCardData(transaction: DatabaseTransaction): Promise<void> {
  for (const [table, trigger] of GUARDED) {
    await transaction.execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`));
  }

  await transaction.delete(giftCardEntries);
  await transaction.execute(sql`UPDATE settlement_tenders SET gift_card_id = NULL WHERE gift_card_id IS NOT NULL`);
  await transaction.execute(sql`UPDATE order_refunds SET gift_card_id = NULL WHERE gift_card_id IS NOT NULL`);
  await transaction.delete(giftCardSales);
  await transaction.delete(giftCardPurchasers);
  await transaction.delete(giftCardEscheatments);
  await transaction.delete(giftCards);
  await transaction.delete(giftCardStockBatches);
  await transaction.delete(giftCardNumberCounters);
  await transaction.delete(giftCardPrograms);

  for (const [table, trigger] of GUARDED) {
    await transaction.execute(sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`));
  }
}
