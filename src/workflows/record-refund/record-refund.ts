import type { Database } from "@/db";
import { withTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { reversePointsForRefund } from "@/modules/reservations/services/loyalty-service";
import {
  recordRefundInTransaction,
  type RecordRefundInput,
  type RefundResult,
} from "@/modules/settlements/services/refund-service";

export type RecordedRefund = RefundResult & {
  replayed: boolean;
  /** Phase 33 (policies 7, 8): loyalty points taken back, and those that couldn't be. */
  loyaltyPointsTaken: number;
  loyaltyPointsShort: number;
};

/**
 * Phase 33 (policy 12, amendment 4): records a refund (Settlements) and takes back the
 * loyalty points it paid for (Reservations) in one transaction, under the refund's
 * idempotency key. A retry returns the first outcome and moves nothing again. The refund is
 * never refused for points.
 */
export async function recordRefund(
  database: Database,
  actor: Actor,
  orderId: string,
  input: RecordRefundInput,
): Promise<RecordedRefund> {
  const result = await withTransaction(database, (transaction) =>
    recordRefundInTransaction(transaction, actor, orderId, input, async (tx, refund, at) => {
      const points = await reversePointsForRefund(tx, actor, refund, at);

      return { loyaltyPointsTaken: points.taken, loyaltyPointsShort: points.short };
    }),
  );

  return {
    ...result,
    loyaltyPointsTaken: Number(result.loyaltyPointsTaken ?? 0),
    loyaltyPointsShort: Number(result.loyaltyPointsShort ?? 0),
  };
}
