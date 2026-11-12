import { and, asc, between, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@/db";
import {
  employees,
  orderRefunds,
  orders,
  positions,
  settlements,
  settlementTenders,
  tipDistributionLines,
  tipDistributions,
  tipPoolRulePositions,
  tipPoolRules,
} from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { AuthorizationError, BusinessRuleError, NotFoundError, ValidationError } from "@/shared/errors/app-error";
import { addDecimals, subtractDecimals, toScale } from "@/shared/decimal/decimal";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { looksLikeCardNumber } from "../rules/settlement-math";
import { assertPermission } from "./access";

// Phase 18 tip pools (approved policies D21-D28). Record only. One rule per Location; one
// FINALIZED distribution per Location and business date. Finalizing is a cross-domain workflow
// (`src/workflows/finalize-tip-distribution`), because worked hours come from Scheduling.

function assertAny(actor: Actor, permissions: readonly PermissionCode[]): void {
  if (!permissions.some((permission) => actor.permissions.has(permission))) {
    throw new AuthorizationError();
  }
}

// ------------------------------------------------------------------ rule

export type TipRuleView = {
  id: string | null;
  name: string | null;
  active: boolean;
  version: number | null;
  positions: { positionId: string; code: string; name: string; points: string }[];
};

export async function readTipRule(executor: DatabaseExecutor, locationId: string): Promise<TipRuleView> {
  const [rule] = await executor.select().from(tipPoolRules).where(eq(tipPoolRules.locationId, locationId));

  if (!rule) {
    return { id: null, name: null, active: false, version: null, positions: [] };
  }

  const rows = await executor
    .select({
      positionId: tipPoolRulePositions.positionId,
      code: positions.code,
      name: positions.name,
      points: tipPoolRulePositions.points,
    })
    .from(tipPoolRulePositions)
    .innerJoin(positions, eq(positions.id, tipPoolRulePositions.positionId))
    .where(and(eq(tipPoolRulePositions.ruleId, rule.id), eq(tipPoolRulePositions.active, true)))
    .orderBy(asc(positions.name));

  return { id: rule.id, name: rule.name, active: rule.active, version: rule.version, positions: rows };
}

export async function getTipRule(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "tips.manage");

  const rule = await readTipRule(executor, actor.locationId);
  const choices = await executor
    .select({ id: positions.id, code: positions.code, name: positions.name })
    .from(positions)
    .where(and(eq(positions.organizationId, actor.organizationId), eq(positions.active, true)))
    .orderBy(asc(positions.name));

  return { rule, positions: choices };
}

const POINTS = /^\d{1,4}(\.\d{1,2})?$/;

/** Policy D23. Removed positions are deactivated; the change is audited. */
export async function saveTipRule(
  database: Database,
  actor: Actor,
  input: {
    name: string | null;
    active: boolean;
    positions: { positionId: string; points: string }[];
    expectedVersion: number | null;
  },
) {
  assertPermission(actor, "tips.manage");

  const ids = input.positions.map((position) => position.positionId);

  if (new Set(ids).size !== ids.length) {
    throw new ValidationError("List each position once.");
  }

  for (const position of input.positions) {
    if (!POINTS.test(position.points) || /^0+(\.0+)?$/.test(position.points)) {
      throw new ValidationError("Enter points greater than zero, with at most two decimal places.");
    }
  }

  if (input.active && input.positions.length === 0) {
    throw new BusinessRuleError("TIP_POOL_EMPTY", "An active pool needs at least one position.");
  }

  const name = input.name?.trim() || null;

  if (name && (name.length > 80 || looksLikeCardNumber(name))) {
    throw new ValidationError("Enter a name of up to 80 characters.");
  }

  return withTransaction(database, async (transaction) => {
    const valid =
      ids.length === 0
        ? []
        : await transaction
            .select({ id: positions.id, code: positions.code })
            .from(positions)
            .where(and(inArray(positions.id, ids), eq(positions.organizationId, actor.organizationId)));

    if (valid.length !== ids.length) {
      throw new NotFoundError("position");
    }

    const [existing] = await transaction
      .select()
      .from(tipPoolRules)
      .where(eq(tipPoolRules.locationId, actor.locationId))
      .for("update");

    if ((existing?.version ?? null) !== input.expectedVersion) {
      throw new ConcurrencyError("tip pool rule", actor.locationId);
    }

    const now = new Date();
    const rule = existing
      ? (
          await transaction
            .update(tipPoolRules)
            .set({ name, active: input.active, version: sql`${tipPoolRules.version} + 1`, updatedAt: now })
            .where(eq(tipPoolRules.id, existing.id))
            .returning()
        )[0]!
      : (
          await transaction
            .insert(tipPoolRules)
            .values({ organizationId: actor.organizationId, locationId: actor.locationId, name, active: input.active })
            .returning()
        )[0]!;
    const current = await transaction
      .select()
      .from(tipPoolRulePositions)
      .where(eq(tipPoolRulePositions.ruleId, rule.id));

    for (const row of current) {
      const wanted = input.positions.find((position) => position.positionId === row.positionId);

      await transaction
        .update(tipPoolRulePositions)
        .set({ active: wanted !== undefined, points: wanted?.points ?? row.points, updatedAt: now })
        .where(eq(tipPoolRulePositions.id, row.id));
    }

    const added = input.positions.filter((position) => !current.some((row) => row.positionId === position.positionId));

    if (added.length > 0) {
      await transaction
        .insert(tipPoolRulePositions)
        .values(added.map((position) => ({ ruleId: rule.id, positionId: position.positionId, points: position.points })));
    }

    const codes = new Map(valid.map((row) => [row.id, row.code]));

    await recordAudit(transaction, actor, {
      action: "tips.rule-changed",
      entityId: rule.id,
      after: {
        active: rule.active,
        positions: input.positions.map((position) => `${codes.get(position.positionId)}:${position.points}`),
      },
    });

    return { id: rule.id, version: rule.version };
  });
}

// ------------------------------------------------------------------ pool facts

export type PoolTotals = { cashTips: string; cardTips: string; poolTotal: string };

/** Policy D22: RECORDED tender tips on COMPLETED settlements of CLOSED orders on the date. */
export async function readPoolTotals(
  executor: DatabaseExecutor,
  input: { locationId: string; businessDate: string },
): Promise<PoolTotals> {
  const [row] = await executor
    .select({
      cash: sql<string>`COALESCE(SUM(${settlementTenders.tipAmount}) FILTER (WHERE ${settlementTenders.tenderType} = 'CASH'), 0)::numeric(12,2)::text`,
      card: sql<string>`COALESCE(SUM(${settlementTenders.tipAmount}) FILTER (WHERE ${settlementTenders.tenderType} = 'EXTERNAL_CARD'), 0)::numeric(12,2)::text`,
      total: sql<string>`COALESCE(SUM(${settlementTenders.tipAmount}), 0)::numeric(12,2)::text`,
    })
    .from(settlementTenders)
    .innerJoin(settlements, eq(settlements.id, settlementTenders.settlementId))
    .innerJoin(orders, eq(orders.id, settlements.orderId))
    .where(
      and(
        eq(orders.locationId, input.locationId),
        eq(orders.businessDate, input.businessDate),
        eq(orders.status, "CLOSED"),
        eq(settlements.status, "COMPLETED"),
        eq(settlementTenders.status, "RECORDED"),
      ),
    );

  // Phase 20 (policy 18, D17): tips handed back with a RECORDED refund leave the pool of the
  // order's business date (a tip refund is refused once that date is finalized).
  const [back] = await executor
    .select({
      cash: sql<string>`COALESCE(SUM(${orderRefunds.tipAmount}) FILTER (WHERE ${orderRefunds.tenderType} = 'CASH'), 0)::numeric(12,2)::text`,
      card: sql<string>`COALESCE(SUM(${orderRefunds.tipAmount}) FILTER (WHERE ${orderRefunds.tenderType} = 'EXTERNAL_CARD'), 0)::numeric(12,2)::text`,
    })
    .from(orderRefunds)
    .innerJoin(orders, eq(orders.id, orderRefunds.orderId))
    .where(
      and(
        eq(orders.locationId, input.locationId),
        eq(orders.businessDate, input.businessDate),
        eq(orderRefunds.status, "RECORDED"),
      ),
    );
  const cashTips = toScale(subtractDecimals(row!.cash, back!.cash), 2);
  const cardTips = toScale(subtractDecimals(row!.card, back!.card), 2);

  return { cashTips, cardTips, poolTotal: toScale(addDecimals(cashTips, cardTips), 2) };
}

/** Policy D25: what still blocks finalizing a date. */
export async function readOpenChecks(
  executor: DatabaseExecutor,
  input: { locationId: string; businessDate: string },
): Promise<{ openOrders: number; openSettlements: number }> {
  const [row] = await executor
    .select({
      openOrders: sql<number>`COUNT(*) FILTER (WHERE ${orders.status} = 'OPEN')::int`,
      openSettlements: sql<number>`(
        SELECT COUNT(*)::int FROM ${settlements} s
        JOIN ${orders} o ON o.id = s.order_id
        WHERE o.location_id = ${input.locationId} AND o.business_date = ${input.businessDate} AND s.status = 'OPEN'
      )`,
    })
    .from(orders)
    .where(and(eq(orders.locationId, input.locationId), eq(orders.businessDate, input.businessDate)));

  return { openOrders: row?.openOrders ?? 0, openSettlements: row?.openSettlements ?? 0 };
}

export async function findFinalizedDistribution(
  executor: DatabaseExecutor,
  input: { locationId: string; businessDate: string },
) {
  const [row] = await executor
    .select()
    .from(tipDistributions)
    .where(
      and(
        eq(tipDistributions.locationId, input.locationId),
        eq(tipDistributions.businessDate, input.businessDate),
        eq(tipDistributions.status, "FINALIZED"),
      ),
    );

  return row ?? null;
}

// ------------------------------------------------------------------ distributions

async function linesOf(executor: DatabaseExecutor, distributionIds: readonly string[]) {
  if (distributionIds.length === 0) {
    return [];
  }

  return executor
    .select({
      distributionId: tipDistributionLines.distributionId,
      employeeId: tipDistributionLines.employeeId,
      employeeNumber: employees.employeeNumber,
      employeeName: sql<string>`COALESCE(${employees.preferredName}, ${employees.firstName}) || ' ' || ${employees.lastName}`,
      positionId: tipDistributionLines.positionId,
      positionCode: tipDistributionLines.positionCodeSnapshot,
      workedHours: tipDistributionLines.workedHours,
      points: tipDistributionLines.points,
      weightedHours: tipDistributionLines.weightedHours,
      share: tipDistributionLines.share,
    })
    .from(tipDistributionLines)
    .innerJoin(employees, eq(employees.id, tipDistributionLines.employeeId))
    .where(inArray(tipDistributionLines.distributionId, [...distributionIds]))
    .orderBy(asc(employees.employeeNumber), asc(tipDistributionLines.positionCodeSnapshot));
}

/** Finalized and voided distributions in a date range, newest first, with their lines. */
export async function listDistributions(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { from: string; to: string },
) {
  assertAny(actor, ["tips.manage", "reports.tips"]);

  const rows = await executor
    .select()
    .from(tipDistributions)
    .where(
      and(
        eq(tipDistributions.locationId, actor.locationId),
        between(tipDistributions.businessDate, input.from, input.to),
      ),
    )
    .orderBy(desc(tipDistributions.businessDate), desc(tipDistributions.finalizedAt));
  const lines = await linesOf(
    executor,
    rows.map((row) => row.id),
  );

  return rows.map((row) => ({ ...row, lines: lines.filter((line) => line.distributionId === row.id) }));
}

export async function voidDistribution(
  database: Database,
  actor: Actor,
  distributionId: string,
  input: { expectedVersion: number; reason: string },
) {
  assertPermission(actor, "tips.manage");

  const reason = input.reason.trim();

  if (reason.length === 0 || reason.length > 500 || looksLikeCardNumber(reason)) {
    throw new ValidationError("Enter a reason of up to 500 characters.");
  }

  return withTransaction(database, async (transaction: DatabaseTransaction) => {
    const [row] = await transaction
      .select()
      .from(tipDistributions)
      .where(and(eq(tipDistributions.id, distributionId), eq(tipDistributions.locationId, actor.locationId)))
      .for("update");

    if (!row) {
      throw new NotFoundError("tip distribution");
    }

    if (row.version !== input.expectedVersion) {
      throw new ConcurrencyError("tip distribution", row.id);
    }

    if (row.status !== "FINALIZED") {
      throw new BusinessRuleError("TIP_DISTRIBUTION_VOIDED", "This distribution is already voided.");
    }

    const now = new Date();
    const [updated] = await transaction
      .update(tipDistributions)
      .set({
        status: "VOIDED",
        voidedAt: now,
        voidedByUserId: actor.userId,
        voidReason: reason,
        version: sql`${tipDistributions.version} + 1`,
        updatedAt: now,
      })
      .where(eq(tipDistributions.id, row.id))
      .returning({ id: tipDistributions.id, version: tipDistributions.version });

    await recordAudit(transaction, actor, {
      action: "tips.distribution-voided",
      entityId: row.id,
      details: { businessDate: row.businessDate, poolTotal: row.poolTotal, reason },
    });

    return updated!;
  });
}

/** `/my-time`: the caller's own shares in FINALIZED distributions (policy D26). */
export async function getMyTipShares(executor: DatabaseExecutor, actor: Actor, input: { from: string; to: string }) {
  assertPermission(actor, "timeclock.punch");

  const [linked] = await executor
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.userId, actor.userId), eq(employees.organizationId, actor.organizationId)));

  if (!linked) {
    return [];
  }

  return executor
    .select({
      businessDate: tipDistributions.businessDate,
      positionCode: tipDistributionLines.positionCodeSnapshot,
      workedHours: tipDistributionLines.workedHours,
      share: tipDistributionLines.share,
    })
    .from(tipDistributionLines)
    .innerJoin(tipDistributions, eq(tipDistributions.id, tipDistributionLines.distributionId))
    .where(
      and(
        eq(tipDistributionLines.employeeId, linked.id),
        eq(tipDistributions.locationId, actor.locationId),
        eq(tipDistributions.status, "FINALIZED"),
        between(tipDistributions.businessDate, input.from, input.to),
      ),
    )
    .orderBy(desc(tipDistributions.businessDate), asc(tipDistributionLines.positionCodeSnapshot));
}
