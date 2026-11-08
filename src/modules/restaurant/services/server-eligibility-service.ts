import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { findPositionCodes } from "@/modules/employees/queries/position-codes";
import {
  findSchedulingFacts,
  type SchedulingEmployeeFacts,
} from "@/modules/employees/queries/scheduling-facts";
import { findPublishedShiftsAt } from "@/modules/scheduling/queries/published-shift-facts";
import { AuthorizationError, BusinessRuleError } from "@/shared/errors/app-error";

import {
  evaluateServerAssignment,
  isServerOnMatchingShift,
  isServerQualified,
  type ServerFacts,
} from "../rules/server-eligibility";
import type { AreaType } from "../types";
import { actorHolds, readLocationClock } from "./access";

function toServerFacts(
  employee: SchedulingEmployeeFacts,
  codes: ReadonlyMap<string, string>,
): ServerFacts {
  return {
    employmentStatus: employee.employmentStatus,
    locations: employee.locations,
    positions: employee.positions.flatMap((position) => {
      const positionCode = codes.get(position.positionId);

      return positionCode ? [{ ...position, positionCode }] : [];
    }),
  };
}

async function loadFacts(
  executor: DatabaseExecutor,
  actor: Actor,
  employeeIds: readonly string[] | undefined,
) {
  // One after the other: inside a transaction these share a single connection.
  const employees = await findSchedulingFacts(executor, {
    organizationId: actor.organizationId,
    ...(employeeIds ? { employeeIds } : { locationId: actor.locationId }),
  });
  const codes = await findPositionCodes(executor, actor.organizationId);

  return { employees, codes };
}

export type ServerCheckResult = {
  /** The stated reason when a schedule override was used; otherwise null. */
  scheduleOverrideReason: string | null;
};

/**
 * Refuses a server who may not take this work, or returns what must be recorded. Status,
 * location and position failures share one code, because employment status is
 * Management-tier and a host can't see it.
 */
export async function checkServerAssignment(
  executor: DatabaseExecutor,
  actor: Actor,
  input: {
    employeeId: string;
    areaTypes: readonly AreaType[];
    overrideReason?: string | null;
    instant: Date;
  },
): Promise<ServerCheckResult> {
  const clock = await readLocationClock(executor, actor.locationId, input.instant);
  const { employees, codes } = await loadFacts(executor, actor, [input.employeeId]);
  const employee = employees[0];

  if (!employee) {
    throw new BusinessRuleError(
      "SERVER_NOT_QUALIFIED",
      "That employee can't be assigned as a server here.",
    );
  }

  const shiftRows = await findPublishedShiftsAt(executor, {
    locationId: actor.locationId,
    instant: input.instant,
    employeeIds: [input.employeeId],
  });
  const canOverrideSchedule = actorHolds(actor, "restaurant.schedule.override");
  const decision = evaluateServerAssignment({
    facts: toServerFacts(employee, codes),
    locationId: actor.locationId,
    localDate: clock.localDate,
    areaTypes: input.areaTypes,
    activeShiftPositionCodes: shiftRows.flatMap((row) => {
      const code = codes.get(row.positionId);

      return code ? [code] : [];
    }),
    canOverrideSchedule,
    overrideReason: input.overrideReason,
  });

  switch (decision.outcome) {
    case "ON_SHIFT":
      return { scheduleOverrideReason: null };
    case "OVERRIDDEN":
      return { scheduleOverrideReason: decision.reason };
    case "NOT_QUALIFIED":
      throw new BusinessRuleError(
        "SERVER_NOT_QUALIFIED",
        "That employee can't be assigned as a server here.",
      );
    case "REASON_REQUIRED":
      throw new BusinessRuleError(
        "SCHEDULE_OVERRIDE_REASON_REQUIRED",
        "That employee isn't on a published shift right now. Give a reason to override.",
      );
    case "OVERRIDE_DENIED":
      if (input.overrideReason?.trim()) {
        throw new AuthorizationError();
      }

      throw new BusinessRuleError(
        "SERVER_NOT_SCHEDULED",
        "That employee isn't on a published shift right now. A manager can override this.",
      );
  }
}

/** For a section default, which is applied only if it needs no override. */
export async function isServerAssignableWithoutOverride(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { employeeId: string; areaTypes: readonly AreaType[]; instant: Date },
): Promise<boolean> {
  const candidates = await listServerCandidatesForAreas(executor, actor, input);

  return candidates.some(
    (candidate) =>
      candidate.employeeId === input.employeeId && candidate.scheduledNow,
  );
}

/** HR qualification alone, for someone already serving a session that is moving. */
export async function isServerQualifiedFor(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { employeeId: string; areaTypes: readonly AreaType[]; instant: Date },
): Promise<boolean> {
  const clock = await readLocationClock(executor, actor.locationId, input.instant);
  const { employees, codes } = await loadFacts(executor, actor, [input.employeeId]);
  const employee = employees[0];

  return (
    employee !== undefined &&
    isServerQualified({
      facts: toServerFacts(employee, codes),
      locationId: actor.locationId,
      localDate: clock.localDate,
      areaTypes: input.areaTypes,
    })
  );
}

export type ServerCandidate = {
  employeeId: string;
  displayName: string;
  scheduledNow: boolean;
};

/**
 * Qualified employees for these areas, with safe display fields only: no status, no number
 * and nothing from restricted HR. The caller asserts the permission.
 */
export async function listServerCandidatesForAreas(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { areaTypes: readonly AreaType[]; instant: Date },
): Promise<ServerCandidate[]> {
  const clock = await readLocationClock(executor, actor.locationId, input.instant);
  const { employees, codes } = await loadFacts(executor, actor, undefined);
  const shiftRows = await findPublishedShiftsAt(executor, {
    locationId: actor.locationId,
    instant: input.instant,
  });

  return employees.flatMap((employee) => {
    const facts = toServerFacts(employee, codes);
    const scope = {
      facts,
      locationId: actor.locationId,
      localDate: clock.localDate,
      areaTypes: input.areaTypes,
    };

    if (!isServerQualified(scope)) {
      return [];
    }

    return [
      {
        employeeId: employee.id,
        displayName: employee.displayName,
        scheduledNow: isServerOnMatchingShift({
          ...scope,
          activeShiftPositionCodes: shiftRows
            .filter((row) => row.employeeId === employee.id)
            .flatMap((row) => {
              const code = codes.get(row.positionId);

              return code ? [code] : [];
            }),
        }),
      },
    ];
  });
}

/** Employee ID to whether they're still HR-qualified, to flag a session on the floor. */
export async function findDisqualifiedServers(
  executor: DatabaseExecutor,
  actor: Actor,
  input: {
    servers: readonly { employeeId: string; areaType: AreaType }[];
    instant: Date;
  },
): Promise<Set<string>> {
  const clock = await readLocationClock(executor, actor.locationId, input.instant);
  const ids = [...new Set(input.servers.map((server) => server.employeeId))];
  const { employees, codes } = await loadFacts(executor, actor, ids);
  const byId = new Map(employees.map((employee) => [employee.id, employee]));

  return new Set(
    input.servers
      .filter(({ employeeId, areaType }) => {
        const employee = byId.get(employeeId);

        return (
          !employee ||
          !isServerQualified({
            facts: toServerFacts(employee, codes),
            locationId: actor.locationId,
            localDate: clock.localDate,
            areaTypes: [areaType],
          })
        );
      })
      .map((server) => server.employeeId),
  );
}
