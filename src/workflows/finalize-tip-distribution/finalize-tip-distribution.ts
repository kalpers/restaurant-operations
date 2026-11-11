import { and, eq, inArray, ne } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { positions, timeEntries, tipDistributionLines, tipDistributions, tipPoolRules } from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { findSchedulingFacts } from "@/modules/employees/queries/scheduling-facts";
import { findWorkedEntries, hasOpenEntriesOn } from "@/modules/scheduling/queries/worked-time";
import { splitTipPool, totalWeightedHours, type TipLine } from "@/modules/settlements/rules/tip-split";
import { assertPermission } from "@/modules/settlements/services/access";
import {
  findFinalizedDistribution,
  readOpenChecks,
  readPoolTotals,
  readTipRule,
  type PoolTotals,
  type TipRuleView,
} from "@/modules/settlements/services/tip-service";
import { BusinessRuleError, ConflictError } from "@/shared/errors/app-error";

// Phase 18 policies D22-D25. Crosses Settlements (tips, the pool rule, the distribution) and
// Scheduling (worked hours), so it is a workflow. Preview computes and writes nothing;
// finalize writes one immutable snapshot per Location and business date.

export const FINALIZE_TIPS_SCOPE = "tips.finalize";

export type TipPreview = {
  businessDate: string;
  rule: TipRuleView;
  totals: PoolTotals;
  lines: (TipLine & { employeeName: string })[];
  totalWeightedHours: string;
  blockers: { openOrders: number; openSettlements: number; openTimeEntries: boolean };
  finalized: { id: string; version: number; poolTotal: string } | null;
};

async function compute(executor: DatabaseExecutor, actor: Actor, businessDate: string): Promise<TipPreview> {
  const scope = { locationId: actor.locationId, businessDate };
  const rule = await readTipRule(executor, actor.locationId);
  const totals = await readPoolTotals(executor, scope);
  const checks = await readOpenChecks(executor, scope);
  const openTimeEntries = await hasOpenEntriesOn(executor, scope);
  const finalized = await findFinalizedDistribution(executor, scope);
  const points = new Map(rule.active ? rule.positions.map((position) => [position.positionId, position]) : []);
  const entries = (
    await findWorkedEntries(executor, { locationId: actor.locationId, from: businessDate, to: businessDate })
  ).filter((entry) => entry.status === "CLOSED" && points.has(entry.positionId));
  const seconds = new Map<string, { employeeId: string; positionId: string; workedSeconds: number }>();

  for (const entry of entries) {
    const key = `${entry.employeeId}\u0000${entry.positionId}`;
    const current = seconds.get(key) ?? { employeeId: entry.employeeId, positionId: entry.positionId, workedSeconds: 0 };

    current.workedSeconds += entry.workedSeconds;
    seconds.set(key, current);
  }

  const facts = new Map(
    (
      await findSchedulingFacts(executor, {
        organizationId: actor.organizationId,
        employeeIds: [...new Set(entries.map((entry) => entry.employeeId))],
      })
    ).map((row) => [row.id, row]),
  );
  const lines = splitTipPool(
    totals.poolTotal,
    [...seconds.values()].map((row) => ({
      employeeId: row.employeeId,
      employeeNumber: facts.get(row.employeeId)?.employeeNumber ?? "",
      positionId: row.positionId,
      positionCode: points.get(row.positionId)!.code,
      workedSeconds: row.workedSeconds,
      points: points.get(row.positionId)!.points,
    })),
  )
    .map((line) => ({ ...line, employeeName: facts.get(line.employeeId)?.displayName ?? "" }))
    .sort(
      (left, right) =>
        left.employeeNumber.localeCompare(right.employeeNumber) || left.positionCode.localeCompare(right.positionCode),
    );

  return {
    businessDate,
    rule,
    totals,
    lines,
    totalWeightedHours: totalWeightedHours(lines),
    blockers: { ...checks, openTimeEntries },
    finalized: finalized ? { id: finalized.id, version: finalized.version, poolTotal: finalized.poolTotal } : null,
  };
}

export async function previewTipDistribution(executor: DatabaseExecutor, actor: Actor, businessDate: string) {
  assertPermission(actor, "tips.manage");

  return compute(executor, actor, businessDate);
}

export async function finalizeTipDistribution(
  database: Database,
  actor: Actor,
  input: { businessDate: string; idempotencyKey: string },
): Promise<{ id: string; poolTotal: string; lineCount: number }> {
  assertPermission(actor, "tips.manage");

  try {
    return await withTransaction(database, async (transaction) => {
      const outcome = await runIdempotent(
        transaction,
        {
          organizationId: actor.organizationId,
          scope: FINALIZE_TIPS_SCOPE,
          key: input.idempotencyKey,
          actorUserId: actor.userId,
          request: { locationId: actor.locationId, businessDate: input.businessDate },
        },
        async (idempotencyRecordId) => {
          // One finalize at a time per Location, and the date's entries can't change underneath:
          // an adjustment holds its entry FOR UPDATE until it commits.
          await transaction
            .select({ id: tipPoolRules.id })
            .from(tipPoolRules)
            .where(eq(tipPoolRules.locationId, actor.locationId))
            .for("update");
          await transaction
            .select({ id: timeEntries.id })
            .from(timeEntries)
            .where(
              and(
                eq(timeEntries.locationId, actor.locationId),
                eq(timeEntries.businessDate, input.businessDate),
                ne(timeEntries.status, "VOIDED"),
              ),
            )
            .for("share");

          const preview = await compute(transaction, actor, input.businessDate);

          if (!preview.rule.id || !preview.rule.active) {
            throw new BusinessRuleError("TIP_POOL_NOT_CONFIGURED", "Set up an active tip pool before finalizing tips.");
          }

          if (preview.finalized) {
            throw new BusinessRuleError(
              "TIP_DISTRIBUTION_FINALIZED",
              "Tips for this date are already finalized. Void that distribution to redo it.",
            );
          }

          if (preview.blockers.openOrders > 0 || preview.blockers.openSettlements > 0) {
            throw new BusinessRuleError(
              "OPEN_CHECKS_REMAIN",
              "Close every check and settlement for this date before finalizing tips.",
              preview.blockers,
            );
          }

          if (preview.blockers.openTimeEntries) {
            throw new BusinessRuleError(
              "OPEN_TIME_ENTRIES",
              "Everyone must be clocked out for this date before finalizing tips.",
            );
          }

          const now = new Date();
          const codes = new Map(
            (
              await transaction
                .select({ id: positions.id, code: positions.code })
                .from(positions)
                .where(inArray(positions.id, preview.rule.positions.map((position) => position.positionId).concat(preview.lines.map((line) => line.positionId))))
            ).map((row) => [row.id, row.code]),
          );
          const [distribution] = await transaction
            .insert(tipDistributions)
            .values({
              organizationId: actor.organizationId,
              locationId: actor.locationId,
              businessDate: input.businessDate,
              poolTotal: preview.totals.poolTotal,
              cashTips: preview.totals.cashTips,
              cardTips: preview.totals.cardTips,
              totalWeightedHours: preview.totalWeightedHours,
              ruleSnapshot: {
                ruleId: preview.rule.id,
                name: preview.rule.name,
                positions: preview.rule.positions.map((position) => ({
                  positionId: position.positionId,
                  code: position.code,
                  points: position.points,
                })),
              },
              finalizedByUserId: actor.userId,
              finalizedAt: now,
              idempotencyRecordId,
            })
            .returning({ id: tipDistributions.id });

          if (preview.lines.length > 0) {
            await transaction.insert(tipDistributionLines).values(
              preview.lines.map((line) => ({
                distributionId: distribution!.id,
                employeeId: line.employeeId,
                positionId: line.positionId,
                positionCodeSnapshot: codes.get(line.positionId) ?? line.positionCode,
                workedHours: line.workedHours,
                points: line.points,
                weightedHours: line.weightedHours,
                share: line.share,
              })),
            );
          }

          await recordAudit(transaction, actor, {
            action: "tips.distribution-finalized",
            entityId: distribution!.id,
            details: {
              businessDate: input.businessDate,
              poolTotal: preview.totals.poolTotal,
              lineCount: preview.lines.length,
            },
          });

          return { id: distribution!.id, poolTotal: preview.totals.poolTotal, lineCount: preview.lines.length };
        },
      );

      return outcome.response;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("TIP_DISTRIBUTION_FINALIZED", "Tips for this date were just finalized.");
    }

    throw error;
  }
}
