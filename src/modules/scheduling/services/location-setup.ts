import { eq } from "drizzle-orm";

import { schedulingRules } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";

/**
 * Phase 23 (policies 1–2): a new location's scheduling rules. Copied from another location
 * (D2 `SCHEDULING_RULES`) or the defaults, with minimum rest of 8 hours as the seed sets.
 */
export async function createLocationSchedulingRules(
  transaction: DatabaseTransaction,
  input: { locationId: string; copyFromLocationId: string | null },
): Promise<void> {
  const [source] = input.copyFromLocationId
    ? await transaction
        .select()
        .from(schedulingRules)
        .where(eq(schedulingRules.locationId, input.copyFromLocationId))
    : [];

  if (!source) {
    await transaction.insert(schedulingRules).values({ locationId: input.locationId, minimumRestHours: "8.00" });
    return;
  }

  await transaction.insert(schedulingRules).values({
    locationId: input.locationId,
    avoidOvertime: source.avoidOvertime,
    weeklyOvertimeThreshold: source.weeklyOvertimeThreshold,
    minimumRestHours: source.minimumRestHours,
    minimumRestHard: source.minimumRestHard,
    maximumDaysPerWeek: source.maximumDaysPerWeek,
    maximumDaysHard: source.maximumDaysHard,
    maximumConsecutiveDays: source.maximumConsecutiveDays,
    maximumConsecutiveHard: source.maximumConsecutiveHard,
    maximumWeeklyHours: source.maximumWeeklyHours,
    balanceWeekendShifts: source.balanceWeekendShifts,
    balanceClosingShifts: source.balanceClosingShifts,
    preferTargetHours: source.preferTargetHours,
    weekStartDay: source.weekStartDay,
    overtimeMultiplier: source.overtimeMultiplier,
    lateClockInGraceMinutes: source.lateClockInGraceMinutes,
    dailyOvertimeThreshold: source.dailyOvertimeThreshold,
  });
}
