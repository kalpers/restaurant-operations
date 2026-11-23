import { asc, eq } from "drizzle-orm";

import { getGiftCardCodeKey } from "@/config/gift-card-env";
import type { Database } from "@/db";
import { giftCards } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";

import { rekeyLegacyHash } from "../rules/gift-card-code";

// Phase 35 (policies 6 and 7): moves gift card code hashes still in the plain SHA-256 form to
// the keyed form, without knowing any code: the keyed form is HMAC(key, that SHA-256). Run by
// `npm run db:rekey-gift-cards` and by the hourly maintenance run. Safe beside a running app:
// each batch is its own transaction and skips cards another transaction holds (a card in a
// sale is picked up by a later batch or run). Running it again changes nothing. The card's
// version is left alone: the code, balance and status don't change, so a screen holding the
// card must not see a conflict.

export const REKEY_BATCH_SIZE = 500;

export type RekeyResult = {
  /** Rows moved to the keyed form in this run. */
  rekeyed: number;
  /** Batches that changed rows. */
  batches: number;
};

export async function rekeyLegacyGiftCardCodes(
  database: Database,
  options: { batchSize?: number; key?: string } = {},
): Promise<RekeyResult> {
  const batchSize = options.batchSize ?? REKEY_BATCH_SIZE;
  const key = options.key ?? getGiftCardCodeKey();
  const result: RekeyResult = { rekeyed: 0, batches: 0 };

  for (;;) {
    const changed = await withTransaction(database, async (transaction) => {
      const rows = await transaction
        .select({ id: giftCards.id, organizationId: giftCards.organizationId, codeHash: giftCards.codeHash })
        .from(giftCards)
        .where(eq(giftCards.codeHashScheme, "SHA256"))
        .orderBy(asc(giftCards.id))
        .limit(batchSize)
        .for("update", { skipLocked: true });

      const perOrganization = new Map<string, number>();

      for (const row of rows) {
        await transaction
          .update(giftCards)
          .set({ codeHash: rekeyLegacyHash(row.codeHash, key), codeHashScheme: "HMAC_SHA256" })
          .where(eq(giftCards.id, row.id));
        perOrganization.set(row.organizationId, (perOrganization.get(row.organizationId) ?? 0) + 1);
      }

      // Counts only: never a hash or a card.
      for (const [organizationId, count] of perOrganization) {
        await recordAudit(
          transaction,
          { system: true, organizationId },
          { action: "settlements.gift-card-codes-rekeyed", entityId: null, after: { cardsRekeyed: count } },
        );
      }

      return rows.length;
    });

    if (changed > 0) {
      result.rekeyed += changed;
      result.batches += 1;
    }

    if (changed < batchSize) {
      return result;
    }
  }
}
