import { eq, sql } from "drizzle-orm";

import { kitchenTicketItems } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import { redactRowText } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import type { RedactText } from "@/shared/text/free-text-search";

// Phase 34 (policies 12–13, amendment 6): the kitchen's copies of an order item's instructions
// are redacted with the item. A ticket item's status never changes with it, and the freeze
// trigger (migration 0079) accepts only a word-level redaction recorded in this transaction.

export async function redactTicketItemInstructions(
  transaction: DatabaseTransaction,
  actor: Actor,
  orderItemId: string,
  redact: RedactText,
  reason: string,
): Promise<number> {
  const rows = await transaction
    .select()
    .from(kitchenTicketItems)
    .where(eq(kitchenTicketItems.orderItemId, orderItemId))
    .for("update");
  let redacted = 0;

  for (const row of rows) {
    const changed = await redactRowText(
      transaction,
      actor,
      { tableName: "kitchen_ticket_items", rowId: row.id, reason },
      { kitchenInstructionsSnapshot: { columnName: "kitchen_instructions_snapshot", value: row.kitchenInstructionsSnapshot } },
      redact,
    );

    if (changed.kitchenInstructionsSnapshot !== undefined) {
      await transaction
        .update(kitchenTicketItems)
        .set({
          kitchenInstructionsSnapshot: changed.kitchenInstructionsSnapshot,
          version: sql`${kitchenTicketItems.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(kitchenTicketItems.id, row.id));
      redacted += 1;
    }
  }

  return redacted;
}
