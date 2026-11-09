import { and, asc, eq, sql } from "drizzle-orm";

import { settlements, settlementStatusHistory, settlementTenders } from "@/db/schema";
import type { DatabaseExecutor, DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { reconcile } from "../rules/settlement-math";

export type SettlementRow = typeof settlements.$inferSelect;
export type TenderRow = typeof settlementTenders.$inferSelect;

/** A settlement at the actor's location, or not found: another location's look absent. */
export async function findSettlement(executor: DatabaseExecutor, actor: Actor, settlementId: string) {
  const [row] = await executor
    .select()
    .from(settlements)
    .where(
      and(
        eq(settlements.id, settlementId),
        eq(settlements.organizationId, actor.organizationId),
        eq(settlements.locationId, actor.locationId),
      ),
    );

  return row ?? null;
}

/** Locks a settlement (after its order) and checks the version the client saw. */
export async function lockSettlement(
  transaction: DatabaseTransaction,
  actor: Actor,
  settlementId: string,
  expectedVersion: number | null,
): Promise<SettlementRow> {
  const [row] = await transaction
    .select()
    .from(settlements)
    .where(
      and(
        eq(settlements.id, settlementId),
        eq(settlements.organizationId, actor.organizationId),
        eq(settlements.locationId, actor.locationId),
      ),
    )
    .for("update");

  if (!row) {
    throw new NotFoundError("settlement");
  }

  if (expectedVersion !== null && row.version !== expectedVersion) {
    throw new ConcurrencyError("settlement", row.id);
  }

  return row;
}

export async function findOpenSettlementForOrder(executor: DatabaseExecutor, orderId: string) {
  const [row] = await executor
    .select()
    .from(settlements)
    .where(and(eq(settlements.orderId, orderId), eq(settlements.status, "OPEN")));

  return row ?? null;
}

/** Whether an order has an OPEN settlement, which locks its amount. */
export async function hasOpenSettlement(executor: DatabaseExecutor, orderId: string): Promise<boolean> {
  return (await findOpenSettlementForOrder(executor, orderId)) !== null;
}

export async function listTenders(executor: DatabaseExecutor, settlementId: string): Promise<TenderRow[]> {
  return executor
    .select()
    .from(settlementTenders)
    .where(eq(settlementTenders.settlementId, settlementId))
    .orderBy(asc(settlementTenders.recordedAt), asc(settlementTenders.id));
}

/** Recomputes the tender projections exactly from the tender rows and bumps the version. */
export async function refreshSettlementTotals(
  transaction: DatabaseTransaction,
  settlement: SettlementRow,
  values: Partial<typeof settlements.$inferInsert> = {},
): Promise<SettlementRow> {
  const totals = reconcile(settlement.orderAmountSnapshot, await listTenders(transaction, settlement.id));
  const [updated] = await transaction
    .update(settlements)
    .set({
      ...values,
      tenderedAmount: totals.tenderedAmount,
      tipAmount: totals.tipAmount,
      changeDue: totals.changeDue,
      version: sql`${settlements.version} + 1`,
      updatedAt: values.updatedAt ?? new Date(),
    })
    .where(eq(settlements.id, settlement.id))
    .returning();

  return updated!;
}

export async function appendSettlementHistory(
  transaction: DatabaseTransaction,
  entry: { settlementId: string; status: string; reason: string | null; userId: string; at: Date },
) {
  await transaction.insert(settlementStatusHistory).values({
    settlementId: entry.settlementId,
    status: entry.status,
    reason: entry.reason,
    changedByUserId: entry.userId,
    occurredAt: entry.at,
  });
}

/**
 * For order workflows that would change the amount (SEND, voids): refuse early while a
 * settlement is OPEN, before any stock moves. The `orders` trigger is the final guard.
 * Call it with the order row already locked.
 */
export async function assertNoOpenSettlement(executor: DatabaseExecutor, orderId: string): Promise<void> {
  if (await hasOpenSettlement(executor, orderId)) {
    throw new BusinessRuleError(
      "SETTLEMENT_IN_PROGRESS",
      "This order is being settled. Cancel the settlement to change the check.",
    );
  }
}
