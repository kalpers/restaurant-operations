import type { Database } from "@/db";
import { assertVersionMatched } from "@/db/helpers/versioning";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { requireEmployee } from "@/modules/employees/services/access";
import { BusinessRuleError, ValidationError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  findExceptionRows,
  findPreferenceRow,
  findRecurringRows,
  insertException,
  insertPreferenceRow,
  insertRecurring,
  updateExceptionRow,
  updatePreferenceRow,
  updateRecurringRow,
} from "../repositories/employee-input-repository";
import { isValidHours, type AvailabilityType } from "../types";
import { assertPermission, resolveSelfEmployeeId } from "./access";

// Availability means can or can't work, and is a hard constraint. Preferences mean would
// rather or rather not, and only affect scores. Each operation exists as a self-service
// form, resolved from the login, and a manager form with an explicit employee.

export type EmployeeTarget =
  | { kind: "self" }
  | { kind: "employee"; employeeId: string };

/** Self-service never reads an employee ID from the request. */
async function resolveTarget(
  executor: DatabaseExecutor,
  actor: Actor,
  target: EmployeeTarget,
): Promise<string> {
  if (target.kind === "self") {
    assertPermission(actor, "schedule.availability.self");

    return resolveSelfEmployeeId(executor, actor);
  }

  assertPermission(actor, "schedule.availability.manage");

  return (await requireEmployee(executor, actor, target.employeeId)).id;
}

export type RecurringInput = {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  availabilityType: AvailabilityType;
  effectiveFrom: string;
  effectiveTo: string | null;
  thisLocationOnly: boolean;
};

function assertEffectiveRange(from: string, to: string | null): void {
  if (to !== null && from > to) {
    throw new ValidationError("The start date must not be after the end date.");
  }
}

export async function getAvailability(
  executor: DatabaseExecutor,
  actor: Actor,
  target: EmployeeTarget,
) {
  const employeeId = await resolveTarget(executor, actor, target);

  return {
    employeeId,
    recurring: await findRecurringRows(executor, [employeeId]),
    exceptions: await findExceptionRows(executor, [employeeId]),
    preferences: (await findPreferenceRow(executor, employeeId)) ?? null,
  };
}

export async function addRecurringAvailability(
  database: Database,
  actor: Actor,
  target: EmployeeTarget,
  input: RecurringInput,
) {
  const employeeId = await resolveTarget(database, actor, target);

  assertEffectiveRange(input.effectiveFrom, input.effectiveTo);

  const { thisLocationOnly, ...values } = input;

  return insertRecurring(database, {
    ...values,
    employeeId,
    locationId: thisLocationOnly ? actor.locationId : null,
  });
}

export async function updateRecurringAvailability(
  database: Database,
  actor: Actor,
  target: EmployeeTarget,
  recordId: string,
  input: RecurringInput & { expectedVersion: number },
) {
  const employeeId = await resolveTarget(database, actor, target);

  assertEffectiveRange(input.effectiveFrom, input.effectiveTo);

  const { thisLocationOnly, expectedVersion, ...values } = input;

  return assertVersionMatched(
    await updateRecurringRow(
      database,
      { id: recordId, employeeId, expectedVersion },
      { ...values, locationId: thisLocationOnly ? actor.locationId : null },
    ),
    { type: "availability", id: recordId },
  );
}

/** Deactivated rather than deleted. */
export async function removeRecurringAvailability(
  database: Database,
  actor: Actor,
  target: EmployeeTarget,
  recordId: string,
  input: { expectedVersion: number },
): Promise<void> {
  const employeeId = await resolveTarget(database, actor, target);

  assertVersionMatched(
    await updateRecurringRow(
      database,
      { id: recordId, employeeId, expectedVersion: input.expectedVersion },
      { active: false },
    ),
    { type: "availability", id: recordId },
  );
}

export type ExceptionInput = {
  exceptionDate: string;
  startTime: string | null;
  endTime: string | null;
  availabilityType: AvailabilityType;
  reason: string | null;
  thisLocationOnly: boolean;
};

export async function addAvailabilityException(
  database: Database,
  actor: Actor,
  target: EmployeeTarget,
  input: ExceptionInput,
) {
  const employeeId = await resolveTarget(database, actor, target);

  if ((input.startTime === null) !== (input.endTime === null)) {
    throw new ValidationError(
      "Enter both a start and an end time, or neither for the whole day.",
    );
  }

  const { thisLocationOnly, ...values } = input;

  return insertException(database, {
    ...values,
    employeeId,
    locationId: thisLocationOnly ? actor.locationId : null,
  });
}

export async function removeAvailabilityException(
  database: Database,
  actor: Actor,
  target: EmployeeTarget,
  recordId: string,
  input: { expectedVersion: number },
): Promise<void> {
  const employeeId = await resolveTarget(database, actor, target);

  assertVersionMatched(
    await updateExceptionRow(
      database,
      { id: recordId, employeeId, expectedVersion: input.expectedVersion },
      { active: false },
    ),
    { type: "availability exception", id: recordId },
  );
}

export type PreferenceInput = {
  targetHoursPerWeek: string | null;
  minimumHoursPerWeek: string | null;
  maximumHoursPerWeek: string | null;
  maximumDaysPerWeek: number | null;
  maximumConsecutiveDays: number | null;
  preferredShiftStart: string | null;
  preferredShiftEnd: string | null;
  preferWeekends: boolean | null;
  preferOpening: boolean | null;
  preferClosing: boolean | null;
};

function assertPreferences(input: PreferenceInput): void {
  for (const hours of [
    input.targetHoursPerWeek,
    input.minimumHoursPerWeek,
    input.maximumHoursPerWeek,
  ]) {
    if (hours !== null && !isValidHours(hours)) {
      throw new ValidationError(
        "Enter hours as a number with at most two decimal places.",
      );
    }
  }

  if ((input.preferredShiftStart === null) !== (input.preferredShiftEnd === null)) {
    throw new ValidationError(
      "Enter both ends of the preferred time window, or neither.",
    );
  }

  if (
    input.minimumHoursPerWeek !== null &&
    input.maximumHoursPerWeek !== null &&
    Number(input.minimumHoursPerWeek) > Number(input.maximumHoursPerWeek)
  ) {
    throw new BusinessRuleError(
      "PREFERRED_HOURS_ORDER",
      "The minimum hours can't be more than the maximum.",
    );
  }
}

/**
 * The employee's general preferences. `expectedVersion` is null when none exist yet, and
 * two people creating the first row at once leaves one with a conflict.
 */
export async function savePreferences(
  database: Database,
  actor: Actor,
  target: EmployeeTarget,
  input: PreferenceInput & { expectedVersion: number | null },
) {
  const employeeId = await resolveTarget(database, actor, target);
  const { expectedVersion, ...values } = input;

  assertPreferences(values);

  const existing = await findPreferenceRow(database, employeeId);

  if (expectedVersion === null) {
    if (existing) {
      throw new ConcurrencyError("preferences", existing.id);
    }

    return insertPreferenceRow(database, {
      ...values,
      employeeId,
      locationId: null,
    });
  }

  if (!existing) {
    throw new ConcurrencyError("preferences", employeeId);
  }

  return assertVersionMatched(
    await updatePreferenceRow(
      database,
      { id: existing.id, expectedVersion },
      values,
    ),
    { type: "preferences", id: existing.id },
  );
}
