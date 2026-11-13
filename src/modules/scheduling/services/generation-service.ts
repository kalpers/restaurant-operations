import type { Database } from "@/db";
import {
  withTransaction,
  type DatabaseExecutor,
} from "@/db/transactions/transaction-context";
import { writeLog } from "@/infrastructure/logging/logger";
import type { Actor } from "@/modules/auth/types";
import {
  findSchedulingFacts,
  lockEmployeesForScheduling,
} from "@/modules/employees/queries/scheduling-facts";
import {
  AppError,
  BusinessRuleError,
  ConflictError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  generate,
  type GeneratorShift,
  type ScheduleProposal,
} from "../generator/schedule-generator";
import {
  findActiveAssignmentsForPeriod,
  findGenerationRuns,
  findPeriodShifts,
  insertAssignment,
  insertGenerationRun,
  updateGenerationRun,
  updatePeriodRow,
  type PeriodRow,
} from "../repositories/schedule-repository";
import { evaluateEligibility } from "../rules/eligibility";
import { SCORING_WEIGHTS } from "../rules/scoring-weights";
import type { GenerationMode } from "../types";
import {
  assertCanReview,
  assertPermission,
  lockEditableDraft,
  requireVisiblePeriod,
} from "./access";
import {
  loadEmployeeContexts,
  loadLocationContext,
  withoutShift,
  type LocationContext,
} from "./scheduling-input";
import { findPeriodForecastIds } from "./forecast-service";

/** Everything the pure generator needs, assembled in one place before it runs. */
async function assembleInput(
  executor: DatabaseExecutor,
  actor: Actor,
  period: PeriodRow,
  location: LocationContext,
) {
  const [shifts, assignments, employees] = await Promise.all([
    findPeriodShifts(executor, period.id),
    findActiveAssignmentsForPeriod(executor, period.id),
    findSchedulingFacts(executor, {
      organizationId: actor.organizationId,
      locationId: period.locationId,
    }),
  ]);
  const contexts = await loadEmployeeContexts(executor, {
    employeeIds: employees.map((employee) => employee.id),
    locationId: period.locationId,
    timeZone: location.timeZone,
    from: period.startDate,
    to: period.endDate,
  });
  const generatorShifts: GeneratorShift[] = shifts.map((shift) => ({
    id: shift.id,
    periodId: period.id,
    locationId: shift.locationId,
    positionId: shift.positionId,
    shiftDate: shift.shiftDate,
    startAt: shift.startAt,
    endAt: shift.endAt,
    priority: shift.priority,
    requiredEmployeeCount: shift.requiredEmployeeCount,
    assignedEmployeeIds: assignments
      .filter((assignment) => assignment.shiftId === shift.id)
      .map((assignment) => assignment.employeeId),
  }));

  return {
    assignments,
    employees,
    contexts,
    shifts: generatorShifts,
  };
}

/** Rules and weights for traceability. No employee data. */
function buildSnapshot(location: LocationContext) {
  return {
    timeZone: location.timeZone,
    rules: location.ruleRow,
    weights: SCORING_WEIGHTS,
  };
}

function assertModeAllowed(
  mode: GenerationMode,
  input: { assignmentCount: number; shiftCount: number },
): void {
  if (input.shiftCount === 0) {
    throw new BusinessRuleError(
      "SCHEDULE_HAS_NO_SHIFTS",
      "Add shifts or apply a staffing template first.",
    );
  }

  if (mode === "GENERATE_DRAFT" && input.assignmentCount > 0) {
    throw new BusinessRuleError(
      "SCHEDULE_NOT_UNASSIGNED",
      "Generate Draft needs a schedule with no assignments. Use Fill Open Shifts to keep existing ones.",
    );
  }
}

/** Run in the write transaction, on fresh data, because availability or time off may have changed. */
async function revalidateProposal(
  executor: DatabaseExecutor,
  actor: Actor,
  period: PeriodRow,
  proposal: ScheduleProposal,
  location: LocationContext,
): Promise<void> {
  const fresh = await assembleInput(executor, actor, period, location);
  const shiftsById = new Map(fresh.shifts.map((shift) => [shift.id, shift]));
  const employeesById = new Map(
    fresh.employees.map((employee) => [employee.id, employee]),
  );
  const contexts = new Map(fresh.contexts);

  for (const assignment of proposal.assignments) {
    const shift = shiftsById.get(assignment.shiftId);
    const employee = employeesById.get(assignment.employeeId);
    const context = contexts.get(assignment.employeeId);

    if (!shift || !employee || !context) {
      throw new ConflictError(
        "GENERATION_STALE",
        "The schedule data changed during generation. Generate again.",
      );
    }

    const result = evaluateEligibility({
      shift,
      employee,
      context: withoutShift(context, shift.id),
      rules: location.rules,
      timeZone: location.timeZone,
    });

    if (!result.eligible) {
      throw new ConflictError(
        "GENERATION_STALE",
        "The schedule data changed during generation. Generate again.",
      );
    }

    // Later proposed assignments must be checked against this one too.
    contexts.set(assignment.employeeId, {
      ...context,
      assignments: [
        ...context.assignments,
        {
          shiftId: shift.id,
          periodId: shift.periodId,
          shiftDate: shift.shiftDate,
          startAt: shift.startAt,
          endAt: shift.endAt,
        },
      ],
    });
  }
}

/**
 * Computes outside a transaction, then writes in one after checking the schedule hasn't
 * moved. Never publishes. A stale version, changed data or any failure writes no
 * assignments and leaves the draft as it was.
 */
export async function runGeneration(
  database: Database,
  actor: Actor,
  periodId: string,
  input: {
    mode: GenerationMode;
    expectedVersion: number;
  },
  hooks: {
    /** For tests: runs after computing and before the write transaction. */
    afterCompute?: () => Promise<void>;
    /** For tests: replaces the generator to exercise failure handling. */
    generator?: typeof generate;
  } = {},
) {
  assertPermission(actor, "schedule.generate");

  const period = await requireVisiblePeriod(database, actor, periodId);

  if (period.status !== "DRAFT") {
    throw new BusinessRuleError(
      "SCHEDULE_NOT_DRAFT",
      "Only a draft schedule can be generated. A published schedule is never regenerated.",
    );
  }

  if (period.version !== input.expectedVersion) {
    throw new ConcurrencyError("schedule period", period.id);
  }

  const location = await loadLocationContext(database, actor);
  const assembled = await assembleInput(database, actor, period, location);

  assertModeAllowed(input.mode, {
    assignmentCount: assembled.assignments.length,
    shiftCount: assembled.shifts.length,
  });

  const run = await insertGenerationRun(database, {
    schedulePeriodId: periodId,
    startedByUserId: actor.userId,
    generationMode: input.mode,
    // Phase 24 (policy 14): which stored forecasts sized the shifts this run fills.
    rulesSnapshot: {
      ...buildSnapshot(location),
      demandForecastIds: await findPeriodForecastIds(database, periodId),
    },
  });

  try {
    const proposal = (hooks.generator ?? generate)({
      periodId,
      timeZone: location.timeZone,
      rules: location.rules,
      shifts: assembled.shifts,
      employees: assembled.employees,
      contexts: assembled.contexts,
    });

    await hooks.afterCompute?.();

    return await withTransaction(database, async (transaction) => {
      await lockEditableDraft(
        transaction,
        actor,
        periodId,
        input.expectedVersion,
      );
      await lockEmployeesForScheduling(
        transaction,
        proposal.assignments.map((assignment) => assignment.employeeId),
      );
      await revalidateProposal(transaction, actor, period, proposal, location);

      for (const assignment of proposal.assignments) {
        await insertAssignment(transaction, {
          shiftId: assignment.shiftId,
          employeeId: assignment.employeeId,
          assignmentSource: "GENERATED",
          assignedByUserId: actor.userId,
          generationRunId: run.id,
          generationRationale: assignment.rationale,
        });
      }

      await updateGenerationRun(transaction, run.id, {
        status: "COMPLETED",
        completedAt: new Date(),
        createdAssignmentCount: proposal.assignments.length,
        unfilledShiftCount: proposal.unfilled.length,
        warningCount: proposal.warnings.length,
        unfilledDetails: proposal.unfilled,
        warnings: proposal.warnings,
      });

      const updated = await updatePeriodRow(transaction, periodId);

      return {
        runId: run.id,
        created: proposal.assignments.length,
        unfilled: proposal.unfilled,
        warnings: proposal.warnings,
        periodVersion: updated.version,
        status: updated.status,
      };
    });
  } catch (error) {
    const known = error instanceof AppError;

    // A safe code only: never driver text, SQL or employee data.
    await updateGenerationRun(database, run.id, {
      status: "FAILED",
      completedAt: new Date(),
      failureCode: known ? error.code : "GENERATION_FAILED",
    });

    if (known) {
      throw error;
    }

    writeLog({
      severity: "error",
      module: "scheduling",
      operation: "run-generation",
      message: "Schedule generation failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    });

    throw new ConflictError(
      "GENERATION_FAILED",
      "The schedule couldn't be generated. Nothing was changed.",
    );
  }
}

export async function listGenerationRuns(
  executor: DatabaseExecutor,
  actor: Actor,
  periodId: string,
) {
  assertCanReview(actor);
  await requireVisiblePeriod(executor, actor, periodId);

  return findGenerationRuns(executor, periodId);
}
