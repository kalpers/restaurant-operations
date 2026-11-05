import { eq } from "drizzle-orm";

import type { Database } from "@/db";
import { employees, schedulingRules } from "@/db/schema";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { assignPosition } from "@/modules/employees/services/assignment-service";
import { addRecurringAvailability } from "@/modules/scheduling/services/availability-service";
import {
  createPeriod,
  createShift,
} from "@/modules/scheduling/services/schedule-service";

import {
  actorWith,
  createEmployeeFixture,
  createHrScenario,
  type HrScenario,
} from "./employee-fixtures";

// 2030-01-07 is a Monday. Dates are far ahead, because swaps refuse shifts already started.
export const WEEK_START = "2030-01-07";
export const WEEK_END = "2030-01-13";
export const MONDAY = "2030-01-07";
export const TUESDAY = "2030-01-08";
export const SATURDAY = "2030-01-12";

export type SchedulingScenario = HrScenario;

export const createSchedulingScenario = createHrScenario;

/** Current version of an employee, which position assignment requires. */
async function employeeVersion(database: Database, employeeId: string) {
  const [row] = await database
    .select({ version: employees.version })
    .from(employees)
    .where(eq(employees.id, employeeId));

  return row!.version;
}

/**
 * An employee at location A holding a position, available all day every day from a date
 * before the test weeks, so a test can remove just the fact it's about.
 */
export async function createSchedulableEmployee(
  database: Database,
  scenario: SchedulingScenario,
  options: {
    positionId?: string | null;
    employeeNumber?: string;
    available?: boolean;
    firstName?: string;
  } = {},
) {
  const positionId =
    options.positionId === undefined ? scenario.server : options.positionId;
  const { id } = await createEmployeeFixture(database, scenario.owner, {
    positionId,
    firstName: options.firstName ?? "Jane",
    ...(options.employeeNumber ? { employeeNumber: options.employeeNumber } : {}),
  });

  if (options.available !== false) {
    await makeAlwaysAvailable(database, scenario.owner, id);
  }

  return id;
}

export async function makeAlwaysAvailable(
  database: Database,
  owner: Actor,
  employeeId: string,
): Promise<void> {
  for (const dayOfWeek of [0, 1, 2, 3, 4, 5, 6]) {
    await addRecurringAvailability(
      database,
      owner,
      { kind: "employee", employeeId },
      {
        dayOfWeek,
        startTime: "00:00",
        endTime: "00:00",
        availabilityType: "AVAILABLE",
        effectiveFrom: "2024-01-15",
        effectiveTo: null,
        thisLocationOnly: false,
      },
    );
  }
}

/** Also gives the employee a position at another location or of another kind. */
export async function addPosition(
  database: Database,
  scenario: SchedulingScenario,
  employeeId: string,
  positionId: string,
): Promise<void> {
  await assignPosition(database, scenario.owner, scenario.owner, {
    employeeId,
    positionId,
    primaryPosition: false,
    effectiveFrom: "2024-01-15",
    expectedVersion: await employeeVersion(database, employeeId),
  });
}

/** An employee linked to a login holding exactly these permissions at location A. */
export async function createLinkedEmployee(
  database: Database,
  scenario: SchedulingScenario,
  granted: readonly PermissionCode[],
  options: { positionId?: string | null } = {},
) {
  const actor = await actorWith(
    database,
    {
      organizationId: scenario.organizationId,
      locationA: scenario.locationA,
    },
    granted,
  );
  const employeeId = await createSchedulableEmployee(database, scenario, options);

  await database
    .update(employees)
    .set({ userId: actor.userId })
    .where(eq(employees.id, employeeId));

  return { actor, employeeId };
}

export async function createDraftPeriod(
  database: Database,
  actor: Actor,
  overrides: { startDate?: string; endDate?: string; name?: string } = {},
) {
  return createPeriod(database, actor, {
    name: overrides.name ?? "Test week",
    startDate: overrides.startDate ?? WEEK_START,
    endDate: overrides.endDate ?? WEEK_END,
  });
}

export async function createShiftFixture(
  database: Database,
  actor: Actor,
  period: { id: string; version: number },
  scenario: { server: string },
  overrides: Partial<Parameters<typeof createShift>[3]> = {},
) {
  return createShift(database, actor, period.id, {
    positionId: scenario.server,
    restaurantAreaId: null,
    shiftDate: MONDAY,
    startTime: "17:00",
    endTime: "22:00",
    requiredEmployeeCount: 1,
    courseOrStationNote: null,
    notes: null,
    priority: 0,
    expectedPeriodVersion: period.version,
    ...overrides,
  });
}

export async function setRules(
  database: Database,
  locationId: string,
  values: Partial<typeof schedulingRules.$inferInsert>,
): Promise<void> {
  await database
    .insert(schedulingRules)
    .values({ locationId, minimumRestHours: null, ...values })
    .onConflictDoUpdate({
      target: schedulingRules.locationId,
      set: { minimumRestHours: null, ...values },
    });
}
