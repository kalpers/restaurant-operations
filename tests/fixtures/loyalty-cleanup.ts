import { sql } from "drizzle-orm";

import {
  guestLoyaltyBalances,
  guestLoyaltyEntries,
  guestLoyaltyPrograms,
  guestLoyaltyRedemptions,
  guestLoyaltyRewardNumberCounters,
  guestLoyaltyRewards,
} from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";

const GUARDED = [
  ["guest_loyalty_entries", "guest_loyalty_entries_guard"],
  ["guest_loyalty_balances", "guest_loyalty_balances_guard"],
  ["guest_loyalty_redemptions", "guest_loyalty_redemptions_guard"],
  ["guest_loyalty_rewards", "guest_loyalty_rewards_guard"],
] as const;

/**
 * Phase 30: every loyalty row. The ledger, balances, redemptions and rewards are guarded, so
 * the guards are lifted for the caller's transaction only (test database). Loyalty rows point at
 * orders, discounts, parties and profiles, so this runs before those are cleared.
 */
export async function clearLoyaltyData(transaction: DatabaseTransaction): Promise<void> {
  for (const [table, trigger] of GUARDED) {
    await transaction.execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`));
  }

  await transaction.delete(guestLoyaltyEntries);
  await transaction.delete(guestLoyaltyRedemptions);
  await transaction.delete(guestLoyaltyBalances);
  await transaction.delete(guestLoyaltyRewards);
  await transaction.delete(guestLoyaltyRewardNumberCounters);
  await transaction.delete(guestLoyaltyPrograms);

  for (const [table, trigger] of GUARDED) {
    await transaction.execute(sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`));
  }
}
