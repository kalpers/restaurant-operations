import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  findLinkedEmployeeId,
  findSchedulingFacts,
} from "@/modules/employees/queries/scheduling-facts";
import { addDays, localDateOf } from "@/shared/time/zoned-time";

import { findPublishedShiftsForEmployee } from "../repositories/employee-input-repository";
import { actorHolds, assertPermission } from "./access";
import { loadLocationContext } from "./scheduling-input";

/**
 * The signed-in user's own published shifts, from a week ago to a year ahead. The
 * employee comes from the login link. A user with no employee record gets `linked: false`
 * rather than an error, so the page can say so.
 */
export async function getMySchedule(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "schedule.view");

  const employeeId = await findLinkedEmployeeId(executor, {
    userId: actor.userId,
    organizationId: actor.organizationId,
  });

  if (!employeeId) {
    return { linked: false as const };
  }

  const { timeZone } = await loadLocationContext(executor, actor);
  const today = localDateOf(new Date(), timeZone);

  return {
    linked: true as const,
    employeeId,
    timeZone,
    shifts: await findPublishedShiftsForEmployee(executor, employeeId, {
      from: addDays(today, -7),
      to: addDays(today, 366),
    }),
  };
}

/** Current staff at this location: names only, from the General tier. */
export async function listColleagues(executor: DatabaseExecutor, actor: Actor) {
  if (!actorHolds(actor, "schedule.availability.manage")) {
    assertPermission(actor, "schedule.view");
  }

  const facts = await findSchedulingFacts(executor, {
    organizationId: actor.organizationId,
    locationId: actor.locationId,
  });

  return facts
    .filter((row) =>
      row.locations.some(
        (location) =>
          location.locationId === actor.locationId &&
          location.effectiveTo === null,
      ),
    )
    .map((row) => ({ id: row.id, displayName: row.displayName }));
}
