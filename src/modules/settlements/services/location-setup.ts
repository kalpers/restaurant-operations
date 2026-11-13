import { and, count, eq } from "drizzle-orm";

import { cashDrawerSessions, settlements, tipPoolRulePositions, tipPoolRules } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";

/** Phase 23 (policy 2, D2 `TIP_POOL_RULES`): the source's tip pool rule and its active positions. */
export async function copyTipPoolRules(
  transaction: DatabaseTransaction,
  input: { organizationId: string; fromLocationId: string; toLocationId: string },
): Promise<number> {
  const [rule] = await transaction
    .select()
    .from(tipPoolRules)
    .where(eq(tipPoolRules.locationId, input.fromLocationId));

  if (!rule) {
    return 0;
  }

  const [created] = await transaction
    .insert(tipPoolRules)
    .values({
      organizationId: input.organizationId,
      locationId: input.toLocationId,
      name: rule.name,
      active: rule.active,
    })
    .returning({ id: tipPoolRules.id });
  const positions = await transaction
    .select({ positionId: tipPoolRulePositions.positionId, points: tipPoolRulePositions.points })
    .from(tipPoolRulePositions)
    .where(and(eq(tipPoolRulePositions.ruleId, rule.id), eq(tipPoolRulePositions.active, true)));

  if (positions.length > 0) {
    await transaction
      .insert(tipPoolRulePositions)
      .values(positions.map((position) => ({ ...position, ruleId: created!.id })));
  }

  return 1;
}

/** Phase 23 (policy 3): settlement work that would be stranded if the location closed. */
export async function findOpenSettlementWork(
  transaction: DatabaseTransaction,
  locationId: string,
): Promise<string[]> {
  const [open] = await transaction
    .select({ total: count() })
    .from(settlements)
    .where(and(eq(settlements.locationId, locationId), eq(settlements.status, "OPEN")));
  const [drawers] = await transaction
    .select({ total: count() })
    .from(cashDrawerSessions)
    .where(and(eq(cashDrawerSessions.locationId, locationId), eq(cashDrawerSessions.status, "OPEN")));

  return [
    ...((open?.total ?? 0) > 0 ? ["open settlements"] : []),
    ...((drawers?.total ?? 0) > 0 ? ["open cash drawer sessions"] : []),
  ];
}
