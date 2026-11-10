import type { Database } from "@/db";
import { isExclusionViolation, isUniqueViolation } from "@/db/helpers/database-errors";
import { assertVersionMatched } from "@/db/helpers/versioning";
import {
  withTransaction,
  type DatabaseExecutor,
} from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import {
  findSchedulingFacts,
  lockEmployeesForScheduling,
} from "@/modules/employees/queries/scheduling-facts";
import { findPositionInOrganization } from "@/modules/employees/repositories/reference-repository";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { addDays, localToInstant, timeToMinutes } from "@/shared/time/zoned-time";

import { findAreaAtLocation } from "../repositories/config-repository";
import {
  endAssignmentRow,
  findActiveAssignmentsForPeriod,
  findActiveAssignmentsForShift,
  findAssignmentWithShift,
  findPeriods,
  findPeriodShifts,
  findShiftAtLocation,
  hasShiftsOutside,
  insertAssignment,
  insertPeriod,
  insertShift,
  lockPeriod,
  updatePeriodRow,
  updateShiftRow,
  type PeriodRow,
} from "../repositories/schedule-repository";
import { softWarningsFor } from "../rules/candidate-scorer";
import {
  evaluateEligibility,
  HARD_CONSTRAINT_MESSAGES,
  type HardConstraintCode,
} from "../rules/eligibility";
import {
  assertPermission,
  canReviewSchedules,
  lockEditableDraft,
  requireVisiblePeriod,
} from "./access";
import {
  loadEmployeeContexts,
  loadLocationContext,
  withoutShift,
} from "./scheduling-input";

export async function listPeriods(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "schedule.view");

  return findPeriods(
    executor,
    actor.locationId,
    canReviewSchedules(actor)
      ? ["DRAFT", "PUBLISHED", "ARCHIVED"]
      : ["PUBLISHED", "ARCHIVED"],
  );
}

/**
 * The period with its shifts and who's on them. Everyone with `schedule.view` sees names
 * and times, a General-tier fact. Rationale is included only for schedule reviewers.
 */
export async function getPeriodDetail(
  executor: DatabaseExecutor,
  actor: Actor,
  periodId: string,
) {
  assertPermission(actor, "schedule.view");

  const period = await requireVisiblePeriod(executor, actor, periodId);
  const [shifts, assignments] = await Promise.all([
    findPeriodShifts(executor, periodId),
    findActiveAssignmentsForPeriod(executor, periodId),
  ]);
  const facts = await findSchedulingFacts(executor, {
    organizationId: actor.organizationId,
    employeeIds: [...new Set(assignments.map((row) => row.employeeId))],
  });
  const names = new Map(facts.map((row) => [row.id, row.displayName]));
  const showRationale = canReviewSchedules(actor);
  const { timeZone } = await loadLocationContext(executor, actor);

  return {
    period,
    timeZone,
    shifts: shifts.map((shift) => ({
      ...shift,
      assignments: assignments
        .filter((assignment) => assignment.shiftId === shift.id)
        .map((assignment) => ({
          id: assignment.id,
          employeeId: assignment.employeeId,
          employeeName: names.get(assignment.employeeId) ?? "Unknown",
          assignmentSource: assignment.assignmentSource,
          rationale: showRationale ? assignment.generationRationale : null,
        })),
    })),
  };
}

function assertPeriodDates(startDate: string, endDate: string): void {
  if (startDate > endDate) {
    throw new ValidationError("The start date must not be after the end date.");
  }
}

export async function createPeriod(
  database: Database,
  actor: Actor,
  input: { name: string; startDate: string; endDate: string },
) {
  assertPermission(actor, "schedule.edit");
  assertPeriodDates(input.startDate, input.endDate);

  return insertPeriod(database, {
    ...input,
    locationId: actor.locationId,
    createdByUserId: actor.userId,
  });
}

export async function updatePeriod(
  database: Database,
  actor: Actor,
  periodId: string,
  input: {
    name: string;
    startDate: string;
    endDate: string;
    expectedVersion: number;
  },
) {
  assertPermission(actor, "schedule.edit");
  assertPeriodDates(input.startDate, input.endDate);

  return withTransaction(database, async (transaction) => {
    await lockEditableDraft(transaction, actor, periodId, input.expectedVersion);

    if (await hasShiftsOutside(transaction, periodId, input)) {
      throw new BusinessRuleError(
        "SHIFTS_OUTSIDE_PERIOD",
        "Some shifts fall outside those dates. Move or cancel them first.",
      );
    }

    return updatePeriodRow(transaction, periodId, {
      name: input.name,
      startDate: input.startDate,
      endDate: input.endDate,
    });
  });
}

/**
 * Real instants from the shift date and clock times in the location's time zone. An end
 * at or before the start runs into the next day. `shift_date` is the local start date.
 */
export function buildShiftTimes(
  shiftDate: string,
  startTime: string,
  endTime: string,
  timeZone: string,
): { startAt: Date; endAt: Date } {
  const overnight = timeToMinutes(endTime) <= timeToMinutes(startTime);
  const startAt = localToInstant(shiftDate, startTime, timeZone);
  const endAt = localToInstant(
    overnight ? addDays(shiftDate, 1) : shiftDate,
    endTime,
    timeZone,
  );

  if (!startAt || !endAt) {
    throw new BusinessRuleError(
      "SHIFT_TIME_DOES_NOT_EXIST",
      "That local time doesn't exist on that date because the clocks change.",
    );
  }

  return { startAt, endAt };
}

export type ShiftInput = {
  positionId: string;
  restaurantAreaId: string | null;
  shiftDate: string;
  startTime: string;
  endTime: string;
  requiredEmployeeCount: number;
  courseOrStationNote: string | null;
  notes: string | null;
  priority: number;
};

async function validateShiftInput(
  executor: DatabaseExecutor,
  actor: Actor,
  period: PeriodRow,
  input: ShiftInput,
) {
  if (input.shiftDate < period.startDate || input.shiftDate > period.endDate) {
    throw new BusinessRuleError(
      "SHIFT_OUTSIDE_PERIOD",
      "The shift date must be inside the schedule period.",
    );
  }

  const position = await findPositionInOrganization(
    executor,
    input.positionId,
    actor.organizationId,
  );

  if (!position?.active) {
    throw new ValidationError("Choose an active position.");
  }

  if (input.restaurantAreaId) {
    const area = await findAreaAtLocation(
      executor,
      input.restaurantAreaId,
      actor.locationId,
    );

    if (!area?.active) {
      throw new ValidationError("Choose an active area at this location.");
    }
  }
}

function shiftColumns(input: ShiftInput, times: { startAt: Date; endAt: Date }) {
  return {
    positionId: input.positionId,
    restaurantAreaId: input.restaurantAreaId,
    shiftDate: input.shiftDate,
    startAt: times.startAt,
    endAt: times.endAt,
    requiredEmployeeCount: input.requiredEmployeeCount,
    courseOrStationNote: input.courseOrStationNote,
    notes: input.notes,
    priority: input.priority,
  };
}

export async function createShift(
  database: Database,
  actor: Actor,
  periodId: string,
  input: ShiftInput & { expectedPeriodVersion: number },
) {
  assertPermission(actor, "schedule.edit");

  return withTransaction(database, async (transaction) => {
    const period = await lockEditableDraft(
      transaction,
      actor,
      periodId,
      input.expectedPeriodVersion,
    );

    await validateShiftInput(transaction, actor, period, input);

    const { timeZone } = await loadLocationContext(transaction, actor);
    const shift = await insertShift(transaction, {
      schedulePeriodId: periodId,
      locationId: actor.locationId,
      ...shiftColumns(
        input,
        buildShiftTimes(input.shiftDate, input.startTime, input.endTime, timeZone),
      ),
    });

    await updatePeriodRow(transaction, periodId);

    return shift;
  });
}

async function requireOpenShift(
  executor: DatabaseExecutor,
  actor: Actor,
  shiftId: string,
) {
  const shift = await findShiftAtLocation(executor, shiftId, actor.locationId);

  if (!shift || shift.cancelledAt) {
    throw new NotFoundError("shift");
  }

  return shift;
}

/** Existing assignees aren't removed. Publishing revalidates them against the new times. */
export async function updateShift(
  database: Database,
  actor: Actor,
  shiftId: string,
  input: ShiftInput & { expectedVersion: number; expectedPeriodVersion: number },
) {
  assertPermission(actor, "schedule.edit");

  return withTransaction(database, async (transaction) => {
    const existing = await requireOpenShift(transaction, actor, shiftId);
    const period = await lockEditableDraft(
      transaction,
      actor,
      existing.schedulePeriodId,
      input.expectedPeriodVersion,
    );

    await validateShiftInput(transaction, actor, period, input);

    const assigned = await findActiveAssignmentsForShift(transaction, shiftId);

    if (assigned.length > input.requiredEmployeeCount) {
      throw new BusinessRuleError(
        "SHIFT_OVER_ASSIGNED",
        "Remove an assignee before lowering the required count.",
      );
    }

    const { timeZone } = await loadLocationContext(transaction, actor);
    const updated = assertVersionMatched(
      await updateShiftRow(
        transaction,
        shiftId,
        input.expectedVersion,
        shiftColumns(
          input,
          buildShiftTimes(input.shiftDate, input.startTime, input.endTime, timeZone),
        ),
      ),
      { type: "shift", id: shiftId },
    );

    await updatePeriodRow(transaction, period.id);

    return updated;
  });
}

/** Kept, so applying a template again can't bring it back. */
export async function cancelShift(
  database: Database,
  actor: Actor,
  shiftId: string,
  input: { expectedVersion: number; expectedPeriodVersion: number },
): Promise<void> {
  assertPermission(actor, "schedule.edit");

  await withTransaction(database, async (transaction) => {
    const shift = await requireOpenShift(transaction, actor, shiftId);

    await lockEditableDraft(
      transaction,
      actor,
      shift.schedulePeriodId,
      input.expectedPeriodVersion,
    );

    if ((await findActiveAssignmentsForShift(transaction, shiftId)).length > 0) {
      throw new BusinessRuleError(
        "SHIFT_HAS_ASSIGNMENTS",
        "Remove the assignees before cancelling this shift.",
      );
    }

    assertVersionMatched(
      await updateShiftRow(transaction, shiftId, input.expectedVersion, {
        cancelledAt: new Date(),
      }),
      { type: "shift", id: shiftId },
    );
    await updatePeriodRow(transaction, shift.schedulePeriodId);
  });
}

function eligibilityError(violations: readonly HardConstraintCode[]): BusinessRuleError {
  return new BusinessRuleError(
    violations[0] ?? "NOT_ELIGIBLE",
    violations.map((code) => HARD_CONSTRAINT_MESSAGES[code]).join(" "),
  );
}

/**
 * Validates one employee against one shift inside the caller's transaction. Swaps use
 * this too, so they can't apply different rules from manual assignment.
 */
export async function assertEmployeeEligible(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeId: string,
  shift: {
    id: string;
    locationId: string;
    positionId: string;
    shiftDate: string;
    startAt: Date;
    endAt: Date;
  },
) {
  const [facts] = await findSchedulingFacts(executor, {
    organizationId: actor.organizationId,
    employeeIds: [employeeId],
  });

  if (!facts) {
    throw new NotFoundError("employee");
  }

  const { timeZone, rules } = await loadLocationContext(executor, actor);
  const contexts = await loadEmployeeContexts(executor, {
    employeeIds: [employeeId],
    locationId: actor.locationId,
    timeZone,
    from: shift.shiftDate,
    to: shift.shiftDate,
  });
  const context = withoutShift(contexts.get(employeeId)!, shift.id);
  const result = evaluateEligibility({
    shift,
    employee: facts,
    context,
    rules,
    timeZone,
  });

  if (!result.eligible) {
    throw eligibilityError(result.violations);
  }

  return softWarningsFor({ shift, context, rules });
}

export async function assignEmployee(
  database: Database,
  actor: Actor,
  shiftId: string,
  input: {
    employeeId: string;
    notes: string | null;
    expectedPeriodVersion: number;
  },
) {
  assertPermission(actor, "schedule.edit");

  try {
    return await withTransaction(database, async (transaction) => {
      const shift = await requireOpenShift(transaction, actor, shiftId);

      await lockEditableDraft(
        transaction,
        actor,
        shift.schedulePeriodId,
        input.expectedPeriodVersion,
      );
      await lockEmployeesForScheduling(transaction, [input.employeeId]);

      const assigned = await findActiveAssignmentsForShift(transaction, shiftId);

      if (assigned.some((row) => row.employeeId === input.employeeId)) {
        throw new ConflictError(
          "ALREADY_ASSIGNED",
          "This employee is already on this shift.",
        );
      }

      if (assigned.length >= shift.requiredEmployeeCount) {
        throw new BusinessRuleError(
          "SHIFT_FULL",
          "This shift already has everyone it needs.",
        );
      }

      const warnings = await assertEmployeeEligible(
        transaction,
        actor,
        input.employeeId,
        shift,
      );
      const assignment = await insertAssignment(transaction, {
        shiftId,
        employeeId: input.employeeId,
        assignmentSource: "MANUAL",
        assignedByUserId: actor.userId,
        notes: input.notes,
      });

      await updatePeriodRow(transaction, shift.schedulePeriodId);

      return { id: assignment.id, warnings };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "ALREADY_ASSIGNED",
        "This employee is already on this shift.",
      );
    }

    throw error;
  }
}

/** The row is kept as REMOVED. Works on any draft assignment, including a generated one. */
export async function removeAssignment(
  database: Database,
  actor: Actor,
  assignmentId: string,
  input: { expectedPeriodVersion: number },
): Promise<void> {
  assertPermission(actor, "schedule.edit");

  await withTransaction(database, async (transaction) => {
    const assignment = await findAssignmentWithShift(
      transaction,
      assignmentId,
      actor.locationId,
    );

    if (!assignment || assignment.status !== "ACTIVE") {
      throw new NotFoundError("shift assignment");
    }

    await lockEditableDraft(
      transaction,
      actor,
      assignment.periodId,
      input.expectedPeriodVersion,
    );
    await endAssignmentRow(transaction, assignmentId, {
      status: "REMOVED",
      endedByUserId: actor.userId,
    });
    await updatePeriodRow(transaction, assignment.periodId);
  });
}

/** Everyone at this location, with the shared evaluator's verdict on this shift. */
export async function listCandidates(
  executor: DatabaseExecutor,
  actor: Actor,
  shiftId: string,
) {
  assertPermission(actor, "schedule.edit");

  const shift = await requireOpenShift(executor, actor, shiftId);
  const facts = await findSchedulingFacts(executor, {
    organizationId: actor.organizationId,
    locationId: actor.locationId,
  });
  const { timeZone, rules } = await loadLocationContext(executor, actor);
  const contexts = await loadEmployeeContexts(executor, {
    employeeIds: facts.map((row) => row.id),
    locationId: actor.locationId,
    timeZone,
    from: shift.shiftDate,
    to: shift.shiftDate,
  });

  return facts.map((employee) => {
    const context = withoutShift(contexts.get(employee.id)!, shift.id);
    const result = evaluateEligibility({
      shift,
      employee,
      context,
      rules,
      timeZone,
    });

    return {
      employeeId: employee.id,
      employeeNumber: employee.employeeNumber,
      displayName: employee.displayName,
      eligible: result.eligible,
      violations: result.violations,
      warnings: result.eligible ? softWarningsFor({ shift, context, rules }) : [],
    };
  });
}

/**
 * Hard failures across a period's active assignments, from the shared evaluator. An
 * assignment that has become invalid, such as for someone terminated after being
 * scheduled, shows up here rather than being changed.
 */
export async function findPeriodViolations(
  executor: DatabaseExecutor,
  actor: Actor,
  period: PeriodRow,
) {
  const [shifts, assignments] = await Promise.all([
    findPeriodShifts(executor, period.id),
    findActiveAssignmentsForPeriod(executor, period.id),
  ]);
  const employeeIds = [...new Set(assignments.map((row) => row.employeeId))];
  const facts = await findSchedulingFacts(executor, {
    organizationId: actor.organizationId,
    employeeIds,
  });
  const { timeZone, rules } = await loadLocationContext(executor, actor);
  const contexts = await loadEmployeeContexts(executor, {
    employeeIds,
    locationId: period.locationId,
    timeZone,
    from: period.startDate,
    to: period.endDate,
  });
  const shiftsById = new Map(shifts.map((shift) => [shift.id, shift]));
  const factsById = new Map(facts.map((row) => [row.id, row]));

  return assignments.flatMap((assignment) => {
    const shift = shiftsById.get(assignment.shiftId);
    const employee = factsById.get(assignment.employeeId);
    const context = contexts.get(assignment.employeeId);

    if (!shift || !employee || !context) {
      return [];
    }

    const result = evaluateEligibility({
      shift,
      employee,
      context: withoutShift(context, shift.id),
      rules,
      timeZone,
    });

    return result.eligible
      ? []
      : [
          {
            assignmentId: assignment.id,
            shiftId: shift.id,
            employeeId: employee.id,
            employeeName: employee.displayName,
            shiftDate: shift.shiftDate,
            positionName: shift.positionName,
            violations: result.violations,
            message: result.violations
              .map((code) => HARD_CONSTRAINT_MESSAGES[code])
              .join(" "),
          },
        ];
  });
}

/** Revalidates every assignment. Open slots are visible as warnings but don't block. */
export async function publishPeriod(
  database: Database,
  actor: Actor,
  periodId: string,
  input: { expectedVersion: number },
) {
  assertPermission(actor, "schedule.publish");

  try {
    return await withTransaction(database, async (transaction) => {
      const period = await lockEditableDraft(
        transaction,
        actor,
        periodId,
        input.expectedVersion,
      );
      const assignments = await findActiveAssignmentsForPeriod(
        transaction,
        periodId,
      );

      await lockEmployeesForScheduling(
        transaction,
        assignments.map((row) => row.employeeId),
      );

      const violations = await findPeriodViolations(transaction, actor, period);

      if (violations.length > 0) {
        const [first] = violations;

        throw new BusinessRuleError(
          "SCHEDULE_HAS_VIOLATIONS",
          `${violations.length} assignment(s) must be fixed before publishing. ${first?.employeeName} on ${first?.shiftDate}: ${first?.message}`,
        );
      }

      const published = await updatePeriodRow(transaction, periodId, {
        status: "PUBLISHED",
        publishedAt: new Date(),
        publishedByUserId: actor.userId,
      });

      await recordAudit(transaction, actor, {
        action: "scheduling.period-published",
        entityId: periodId,
        before: { status: period.status },
        after: published,
      });

      return published;
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new ConflictError(
        "PUBLISHED_PERIOD_OVERLAP",
        "Another published schedule already covers some of these dates.",
      );
    }

    throw error;
  }
}

export async function archivePeriod(
  database: Database,
  actor: Actor,
  periodId: string,
  input: { expectedVersion: number },
) {
  assertPermission(actor, "schedule.publish");

  return withTransaction(database, async (transaction) => {
    const period = await lockPeriod(transaction, periodId, actor.locationId);

    if (!period) {
      throw new NotFoundError("schedule period");
    }

    if (period.version !== input.expectedVersion) {
      throw new ConcurrencyError("schedule period", period.id);
    }

    if (period.status !== "PUBLISHED") {
      throw new BusinessRuleError(
        "SCHEDULE_NOT_PUBLISHED",
        "Only a published schedule can be archived.",
      );
    }

    const archived = await updatePeriodRow(transaction, periodId, {
      status: "ARCHIVED",
      archivedAt: new Date(),
    });

    await recordAudit(transaction, actor, {
      action: "scheduling.period-archived",
      entityId: periodId,
      before: { status: period.status },
      after: archived,
    });

    return archived;
  });
}
