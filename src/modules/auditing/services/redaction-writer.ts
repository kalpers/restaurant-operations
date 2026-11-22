import { freeTextRedactions, type RedactableTable } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";

// Phase 34 (policies 12–13, amendment 7): the one writer of `free_text_redactions`. Each row
// names the table, row and column a guest erase redacted, and the erase's reason; never the
// text. Written in the transaction of the redaction itself, so `created_at = now()` is what
// the freeze triggers check before accepting the change.

export type FreeTextRedaction = {
  tableName: RedactableTable;
  rowId: string;
  columnName: string;
  reason: string;
};

export async function recordFreeTextRedaction(
  transaction: DatabaseTransaction,
  actor: Pick<Actor, "organizationId" | "userId">,
  redaction: FreeTextRedaction,
): Promise<void> {
  await transaction.insert(freeTextRedactions).values({
    organizationId: actor.organizationId,
    tableName: redaction.tableName,
    rowId: redaction.rowId,
    columnName: redaction.columnName,
    reason: redaction.reason,
    redactedByUserId: actor.userId,
  });
}

/**
 * Redacts the given columns of one row with `redact` and records each column that changed.
 * Returns the new values to write (keyed like `columns`), empty when nothing matched. The
 * caller writes them in the same transaction.
 */
export async function redactRowText<Key extends string>(
  transaction: DatabaseTransaction,
  actor: Pick<Actor, "organizationId" | "userId">,
  target: { tableName: RedactableTable; rowId: string; reason: string },
  columns: Record<Key, { columnName: string; value: string | null }>,
  redact: (text: string) => string,
): Promise<Partial<Record<Key, string>>> {
  const changed: Partial<Record<Key, string>> = {};

  for (const key of Object.keys(columns) as Key[]) {
    const { columnName, value } = columns[key];

    if (!value) {
      continue;
    }

    const redacted = redact(value);

    if (redacted !== value) {
      await recordFreeTextRedaction(transaction, actor, { tableName: target.tableName, rowId: target.rowId, columnName, reason: target.reason });
      changed[key] = redacted;
    }
  }

  return changed;
}
