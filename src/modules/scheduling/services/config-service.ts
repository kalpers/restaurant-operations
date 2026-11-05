import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { assertVersionMatched } from "@/db/helpers/versioning";
import {
  withTransaction,
  type DatabaseExecutor,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { findPositionInOrganization } from "@/modules/employees/repositories/reference-repository";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { addDays, dayOfWeek, localToInstant } from "@/shared/time/zoned-time";

import {
  deactivateRequirementRow,
  findActivePositions,
  findAreaAtLocation,
  findAreas,
  findRequirements,
  findRulesRow,
  findTemplate,
  findTemplates,
  insertRequirement,
  insertRulesRow,
  insertTemplate,
  updateRulesRow,
  updateTemplateRow,
} from "../repositories/config-repository";
import {
  insertTemplateShift,
  updatePeriodRow,
} from "../repositories/schedule-repository";
import {
  DEFAULT_RULE_ROW,
  type SchedulingRuleRow,
} from "../rules/schedule-rules";
import { isValidHours } from "../types";
import { assertPermission, lockEditableDraft } from "./access";
import { buildShiftTimes } from "./schedule-service";
import { loadLocationContext } from "./scheduling-input";

export async function getRules(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "schedule.rules.manage");

  const row = await findRulesRow(executor, actor.locationId);

  return row ?? { ...DEFAULT_RULE_ROW, version: null };
}

function assertRules(input: SchedulingRuleRow): void {
  for (const hours of [
    input.weeklyOvertimeThreshold,
    input.minimumRestHours,
    input.maximumWeeklyHours,
  ]) {
    if (hours !== null && !isValidHours(hours)) {
      throw new ValidationError(
        "Enter hours as a number with at most two decimal places.",
      );
    }
  }

  if (
    (input.minimumRestHard && input.minimumRestHours === null) ||
    (input.maximumDaysHard && input.maximumDaysPerWeek === null) ||
    (input.maximumConsecutiveHard && input.maximumConsecutiveDays === null)
  ) {
    throw new BusinessRuleError(
      "HARD_LIMIT_NEEDS_VALUE",
      "A hard limit needs a value.",
    );
  }
}

/** `expectedVersion` is null only when this location has no rules row yet. */
export async function saveRules(
  database: Database,
  actor: Actor,
  input: SchedulingRuleRow & { expectedVersion: number | null },
) {
  assertPermission(actor, "schedule.rules.manage");

  const { expectedVersion, ...values } = input;

  assertRules(values);

  if (expectedVersion === null) {
    try {
      return await insertRulesRow(database, {
        ...values,
        locationId: actor.locationId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConcurrencyError("scheduling rules", actor.locationId);
      }

      throw error;
    }
  }

  return assertVersionMatched(
    await updateRulesRow(
      database,
      { locationId: actor.locationId, expectedVersion },
      values,
    ),
    { type: "scheduling rules", id: actor.locationId },
  );
}

/** What a shift or template form can choose from, for any schedule editor. */
export async function getShiftFormOptions(
  executor: DatabaseExecutor,
  actor: Actor,
) {
  if (!actor.permissions.has("schedule.edit")) {
    assertPermission(actor, "schedule.templates.manage");
  }

  return {
    positions: await findActivePositions(executor, actor.organizationId),
    areas: await findAreas(executor, actor.locationId),
  };
}

export async function listTemplates(executor: DatabaseExecutor, actor: Actor) {
  if (
    !actor.permissions.has("schedule.templates.manage") &&
    !actor.permissions.has("schedule.edit")
  ) {
    assertPermission(actor, "schedule.templates.manage");
  }

  const templates = await findTemplates(executor, actor.locationId);

  return Promise.all(
    templates.map(async (template) => ({
      ...template,
      requirements: (await findRequirements(executor, template.id)).filter(
        (requirement) => requirement.active,
      ),
    })),
  );
}

function mapDuplicateName(error: unknown): unknown {
  return isUniqueViolation(error)
    ? new ConflictError(
        "TEMPLATE_NAME_EXISTS",
        "A template with this name already exists here.",
      )
    : error;
}

export async function createTemplate(
  database: Database,
  actor: Actor,
  input: { name: string; description: string | null },
) {
  assertPermission(actor, "schedule.templates.manage");

  try {
    return await insertTemplate(database, {
      ...input,
      locationId: actor.locationId,
    });
  } catch (error) {
    throw mapDuplicateName(error);
  }
}

export async function updateTemplate(
  database: Database,
  actor: Actor,
  templateId: string,
  input: {
    name: string;
    description: string | null;
    active: boolean;
    expectedVersion: number;
  },
) {
  assertPermission(actor, "schedule.templates.manage");

  const { expectedVersion, ...changes } = input;

  try {
    return assertVersionMatched(
      await updateTemplateRow(
        database,
        { id: templateId, locationId: actor.locationId, expectedVersion },
        changes,
      ),
      { type: "staffing template", id: templateId },
    );
  } catch (error) {
    throw mapDuplicateName(error);
  }
}

async function requireTemplate(
  executor: DatabaseExecutor,
  actor: Actor,
  templateId: string,
) {
  const template = await findTemplate(executor, templateId, actor.locationId);

  if (!template) {
    throw new NotFoundError("staffing template");
  }

  return template;
}

export async function addRequirement(
  database: Database,
  actor: Actor,
  templateId: string,
  input: {
    dayOfWeek: number;
    positionId: string;
    restaurantAreaId: string | null;
    startTime: string;
    endTime: string;
    requiredEmployeeCount: number;
    priority: number;
  },
) {
  assertPermission(actor, "schedule.templates.manage");
  await requireTemplate(database, actor, templateId);

  if (input.startTime === input.endTime) {
    throw new ValidationError("The start and end times must differ.");
  }

  const position = await findPositionInOrganization(
    database,
    input.positionId,
    actor.organizationId,
  );

  if (!position?.active) {
    throw new ValidationError("Choose an active position.");
  }

  if (input.restaurantAreaId) {
    const area = await findAreaAtLocation(
      database,
      input.restaurantAreaId,
      actor.locationId,
    );

    if (!area?.active) {
      throw new ValidationError("Choose an active area at this location.");
    }
  }

  return insertRequirement(database, {
    ...input,
    staffingTemplateId: templateId,
  });
}

export async function removeRequirement(
  database: Database,
  actor: Actor,
  templateId: string,
  requirementId: string,
): Promise<void> {
  assertPermission(actor, "schedule.templates.manage");
  await requireTemplate(database, actor, templateId);

  const rows = await deactivateRequirementRow(
    database,
    requirementId,
    templateId,
  );

  if (rows.length === 0) {
    throw new NotFoundError("staffing requirement");
  }
}

/**
 * Creates each requirement and date's shift at most once. Existing shifts stay as they
 * are, edited or cancelled, so applying again adds only what's missing and never touches
 * a manager's work. This creates demand, never assignments.
 */
export async function applyTemplate(
  database: Database,
  actor: Actor,
  periodId: string,
  input: { templateId: string; expectedPeriodVersion: number },
) {
  assertPermission(actor, "schedule.edit");

  return withTransaction(database, async (transaction) => {
    const period = await lockEditableDraft(
      transaction,
      actor,
      periodId,
      input.expectedPeriodVersion,
    );
    const template = await requireTemplate(transaction, actor, input.templateId);

    if (!template.active) {
      throw new BusinessRuleError(
        "TEMPLATE_INACTIVE",
        "This staffing template is inactive.",
      );
    }

    const requirements = (await findRequirements(transaction, template.id)).filter(
      (requirement) => requirement.active,
    );
    const { timeZone } = await loadLocationContext(transaction, actor);
    const skipped: { date: string; positionName: string }[] = [];
    let created = 0;

    for (
      let date = period.startDate;
      date <= period.endDate;
      date = addDays(date, 1)
    ) {
      for (const requirement of requirements) {
        if (requirement.dayOfWeek !== dayOfWeek(date)) {
          continue;
        }

        if (!localToInstant(date, requirement.startTime, timeZone)) {
          skipped.push({ date, positionName: requirement.positionName });
          continue;
        }

        let times;

        try {
          times = buildShiftTimes(
            date,
            requirement.startTime,
            requirement.endTime,
            timeZone,
          );
        } catch (error) {
          if (error instanceof BusinessRuleError) {
            skipped.push({ date, positionName: requirement.positionName });
            continue;
          }

          throw error;
        }

        const inserted = await insertTemplateShift(transaction, {
          schedulePeriodId: periodId,
          locationId: actor.locationId,
          positionId: requirement.positionId,
          restaurantAreaId: requirement.restaurantAreaId,
          shiftDate: date,
          ...times,
          requiredEmployeeCount: requirement.requiredEmployeeCount,
          priority: requirement.priority,
          sourceRequirementId: requirement.id,
        });

        if (inserted) {
          created += 1;
        }
      }
    }

    const updatedPeriod =
      created > 0 ? await updatePeriodRow(transaction, periodId) : period;

    return { created, skipped, periodVersion: updatedPeriod.version };
  });
}
