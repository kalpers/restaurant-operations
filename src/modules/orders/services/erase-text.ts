import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";

import { locations, orderItems, orders } from "@/db/schema";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";
import { redactRowText } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { freeTextCondition, hasQuery, joinTexts, type FreeTextCandidate, type FreeTextQuery, type RedactText } from "@/shared/text/free-text-search";

// Phase 34 (policies 11–14, amendment 7): Orders' free text for a guest erase: takeout names
// and item instructions. Candidates only; the erase workflow decides what is a mention. A
// sent item's instructions and a closed check's name are frozen, and the freeze triggers
// (migration 0079) accept only a word-level redaction recorded in the same transaction.

type Scope = { organizationId: string; locationIds: readonly string[] };

export async function findTakeoutNameCandidates(executor: DatabaseExecutor, scope: Scope, query: FreeTextQuery): Promise<FreeTextCandidate[]> {
  if (scope.locationIds.length === 0 || !hasQuery(query)) {
    return [];
  }

  const rows = await executor
    .select({
      id: orders.id,
      locationId: orders.locationId,
      locationName: locations.name,
      date: sql<string>`${orders.businessDate}::text`,
      orderNumber: orders.orderNumber,
      text: orders.customerName,
    })
    .from(orders)
    .innerJoin(locations, eq(locations.id, orders.locationId))
    .where(
      and(
        eq(locations.organizationId, scope.organizationId),
        inArray(orders.locationId, [...scope.locationIds]),
        eq(orders.orderType, "TAKEOUT"),
        isNotNull(orders.customerName),
        freeTextCondition([sql`${orders.customerName}`], query),
      ),
    );

  return rows.map(({ orderNumber, ...row }) => ({ ...row, label: `Takeout order ${orderNumber}`, text: row.text ?? "" }));
}

export async function findItemInstructionCandidates(executor: DatabaseExecutor, scope: Scope, query: FreeTextQuery): Promise<FreeTextCandidate[]> {
  if (scope.locationIds.length === 0 || !hasQuery(query)) {
    return [];
  }

  const rows = await executor
    .select({
      id: orderItems.id,
      locationId: orders.locationId,
      locationName: locations.name,
      date: sql<string>`${orders.businessDate}::text`,
      orderNumber: orders.orderNumber,
      itemName: orderItems.menuItemNameSnapshot,
      special: orderItems.specialInstructions,
      kitchen: orderItems.kitchenInstructionsSnapshot,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(locations, eq(locations.id, orders.locationId))
    .where(
      and(
        eq(locations.organizationId, scope.organizationId),
        inArray(orders.locationId, [...scope.locationIds]),
        or(isNotNull(orderItems.specialInstructions), isNotNull(orderItems.kitchenInstructionsSnapshot)),
        freeTextCondition([sql`${orderItems.specialInstructions}`, sql`${orderItems.kitchenInstructionsSnapshot}`], query),
      ),
    );

  return rows.map((row) => ({
    id: row.id,
    locationId: row.locationId,
    locationName: row.locationName,
    date: row.date,
    label: `Order ${row.orderNumber}: ${row.itemName}`,
    // The kitchen copy usually repeats the instruction; show it once.
    text: row.kitchen && row.special && row.kitchen.includes(row.special) ? row.kitchen : joinTexts(row.special, row.kitchen),
  }));
}

/** Policy 12: replaces the guest's words in a takeout check's name, even on a closed check. */
export async function redactTakeoutName(
  transaction: DatabaseTransaction,
  actor: Actor,
  orderId: string,
  redact: RedactText,
  reason: string,
): Promise<void> {
  const [row] = await transaction.select().from(orders).where(eq(orders.id, orderId)).for("update");

  if (!row) {
    return;
  }

  const changed = await redactRowText(
    transaction,
    actor,
    { tableName: "orders", rowId: row.id, reason },
    { customerName: { columnName: "customer_name", value: row.customerName } },
    redact,
  );

  if (changed.customerName !== undefined) {
    await transaction
      .update(orders)
      .set({ customerName: changed.customerName, version: sql`${orders.version} + 1`, updatedAt: new Date() })
      .where(eq(orders.id, row.id));
  }
}

/** Policy 12: replaces the guest's words in an item's instructions, whatever its status. */
export async function redactItemInstructions(
  transaction: DatabaseTransaction,
  actor: Actor,
  itemId: string,
  redact: RedactText,
  reason: string,
): Promise<void> {
  const [row] = await transaction.select().from(orderItems).where(eq(orderItems.id, itemId)).for("update");

  if (!row) {
    return;
  }

  const changed = await redactRowText(
    transaction,
    actor,
    { tableName: "order_items", rowId: row.id, reason },
    {
      specialInstructions: { columnName: "special_instructions", value: row.specialInstructions },
      kitchenInstructionsSnapshot: { columnName: "kitchen_instructions_snapshot", value: row.kitchenInstructionsSnapshot },
    },
    redact,
  );

  if (Object.keys(changed).length > 0) {
    await transaction
      .update(orderItems)
      .set({ ...changed, version: sql`${orderItems.version} + 1`, updatedAt: new Date() })
      .where(eq(orderItems.id, row.id));
  }
}
