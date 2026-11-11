import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { Database } from "../src/db";
import { VALIDATION_EMPLOYEES, VALIDATION_LABOR_SEED_KEY } from "../src/db/demo/validation-fixture";
import { employees, positions, seedRuns, timeEntries } from "../src/db/schema";
import type { Actor } from "../src/modules/auth/types";
import { adjustEntry, clockIn } from "../src/modules/scheduling/services/timeclock-service";
import { readTipRule, saveTipRule } from "../src/modules/settlements/services/tip-service";
import {
  finalizeTipDistribution,
  previewTipDistribution,
} from "../src/workflows/finalize-tip-distribution/finalize-tip-distribution";

export type ValidationLaborResult =
  | { skipped: true }
  | { skipped: false; entry: boolean; pool: boolean; distribution: "finalized" | "already finalized" | string };

const key = () => `validation-${randomUUID()}`;

/**
 * Phase 18 additions to the validation fixture, through the services as the MAIN Owner: a
 * closed four-hour entry for the validation server today (a manager punch, corrected to start
 * four hours ago), a Server/Bartender tip pool if MAIN has none, and today's distribution when
 * nothing blocks it (open checks or someone on the clock leave it for the operator). Recorded as
 * VALIDATION_LABOR_SEED_KEY once done.
 */
export async function seedValidationLaborTips(database: Database, actor: Actor): Promise<ValidationLaborResult> {
  const [done] = await database.select({ id: seedRuns.id }).from(seedRuns).where(eq(seedRuns.seedKey, VALIDATION_LABOR_SEED_KEY));

  if (done) {
    return { skipped: true };
  }

  const serverNumber = VALIDATION_EMPLOYEES.find((person) => person.position === "SERVER")!.employeeNumber;
  const [server] = await database
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.organizationId, actor.organizationId), eq(employees.employeeNumber, serverNumber)));

  if (!server) {
    throw new Error("The validation server doesn't exist. Run the Phase 13 validation fixture first.");
  }

  // ---- A closed entry for the validation server, unless they already have one.
  const [existing] = await database
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(and(eq(timeEntries.employeeId, server.id), eq(timeEntries.locationId, actor.locationId)));
  let entry = false;

  if (!existing) {
    const punched = await clockIn(database, actor, { employeeId: server.id, positionId: null, idempotencyKey: key() });
    const now = Date.now();

    await adjustEntry(database, actor, punched.entryId, {
      expectedVersion: 1,
      reason: "Phase 18 validation fixture",
      clockInAt: new Date(now - 4 * 3_600_000),
      clockOutAt: new Date(now - 60_000),
    });
    entry = true;
  }

  // ---- A tip pool at MAIN, unless one is set up already.
  const rule = await readTipRule(database, actor.locationId);
  let pool = false;

  if (!rule.id) {
    const ids = new Map(
      (await database.select({ id: positions.id, code: positions.code }).from(positions).where(eq(positions.organizationId, actor.organizationId))).map(
        (row) => [row.code, row.id],
      ),
    );

    await saveTipRule(database, actor, {
      name: "Validation pool",
      active: true,
      positions: [
        { positionId: ids.get("SERVER")!, points: "10" },
        { positionId: ids.get("BARTENDER")!, points: "10" },
      ],
      expectedVersion: null,
    });
    pool = true;
  }

  // ---- Today's distribution, when nothing blocks it.
  const [{ businessDate }] = await database
    .select({ businessDate: timeEntries.businessDate })
    .from(timeEntries)
    .where(eq(timeEntries.employeeId, server.id))
    .limit(1);
  const preview = await previewTipDistribution(database, actor, businessDate);
  let distribution: string;

  if (preview.finalized) {
    distribution = "already finalized";
  } else if (!preview.rule.active) {
    distribution = "skipped: MAIN's tip pool is switched off";
  } else if (preview.blockers.openOrders > 0 || preview.blockers.openSettlements > 0 || preview.blockers.openTimeEntries) {
    distribution = `skipped: ${businessDate} still has open checks or someone on the clock; finalize it on /tips`;
  } else {
    await finalizeTipDistribution(database, actor, { businessDate, idempotencyKey: key() });
    distribution = "finalized";
  }

  await database.insert(seedRuns).values({ seedKey: VALIDATION_LABOR_SEED_KEY }).onConflictDoNothing({ target: seedRuns.seedKey });

  return { skipped: false, entry, pool, distribution };
}
