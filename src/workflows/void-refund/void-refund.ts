import type { Database } from "@/db";
import { withTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { restorePointsForRefundVoid } from "@/modules/reservations/services/loyalty-service";
import { voidRefundInTransaction } from "@/modules/settlements/services/refund-service";

/**
 * Phase 33 (policies 10, 12): voids a refund (Settlements) and puts back exactly the loyalty
 * points it took (Reservations), in one transaction.
 */
export async function voidRefund(
  database: Database,
  actor: Actor,
  refundId: string,
  input: { expectedVersion: number; reason: string },
) {
  const result = await withTransaction(database, (transaction) =>
    voidRefundInTransaction(transaction, actor, refundId, input, async (tx, id, at) => ({
      loyaltyPointsRestored: await restorePointsForRefundVoid(tx, actor, id, at),
    })),
  );

  return { ...result, loyaltyPointsRestored: Number(result.loyaltyPointsRestored ?? 0) };
}
