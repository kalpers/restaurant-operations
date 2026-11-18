import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import type { Actor } from "@/modules/auth/types";

// Phase 27 (policies 2–3): the floor's outbox events. Written in the transaction that makes
// the change, so a refused change writes none; delivered after commit. Identifiers only.

export type TableSessionEventType =
  | "table.session-opened"
  | "table.session-moved"
  | "table.session-tables-changed"
  | "table.session-server-assigned"
  | "table.session-completed"
  | "table.session-cancelled";

export async function writeTableSessionEvent(
  transaction: DatabaseTransaction,
  actor: Actor,
  eventType: TableSessionEventType,
  input: { sessionId: string; tableIds: readonly string[]; occurredAt: Date },
): Promise<void> {
  await writeOutboxEvents(transaction, [
    {
      organizationId: actor.organizationId,
      locationId: actor.locationId,
      eventType,
      aggregateType: "table_session",
      aggregateId: input.sessionId,
      payload: { sessionId: input.sessionId, tableIds: [...input.tableIds] },
      occurredAt: input.occurredAt,
    },
  ]);
}

/** One `table.condition-changed` per table. */
export async function writeTableConditionEvents(
  transaction: DatabaseTransaction,
  actor: Actor,
  tableIds: readonly string[],
  occurredAt: Date,
): Promise<void> {
  await writeOutboxEvents(
    transaction,
    tableIds.map((tableId) => ({
      organizationId: actor.organizationId,
      locationId: actor.locationId,
      eventType: "table.condition-changed",
      aggregateType: "restaurant_table",
      aggregateId: tableId,
      payload: { tableId },
      occurredAt,
    })),
  );
}
