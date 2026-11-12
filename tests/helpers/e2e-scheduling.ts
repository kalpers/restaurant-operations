import { randomBytes, randomUUID } from "node:crypto";

import { eq, inArray, like } from "drizzle-orm";

import { loadLocalEnv, pointAtTestDatabase } from "../../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../../src/db";
import {
  employeeAvailability,
  employeeAvailabilityExceptions,
  employeeLocations,
  employeePositions,
  employees,
  employeeSchedulingPreferences,
  employeeStatusHistory,
  locations,
  permissions,
  positions,
  rolePermissions,
  roles,
  scheduleGenerationRuns,
  schedulePeriods,
  shiftAssignments,
  shifts,
  shiftSwapRequests,
  staffingTemplateRequirements,
  staffingTemplates,
  timeOffRequests,
  userRoles,
  users,
} from "../../src/db/schema";
import { hashPassword } from "../../src/modules/auth/password";
import type { PermissionCode } from "../../src/modules/auth/permission-catalog";
import {
  getUserAuthContext,
  requirePermission,
} from "../../src/modules/auth/services/permission-service";
import type { Actor } from "../../src/modules/auth/types";
import { createEmployee } from "../../src/modules/employees/services/employee-service";
import { addRecurringAvailability } from "../../src/modules/scheduling/services/availability-service";
import {
  assignEmployee,
  createPeriod,
  createShift,
  publishPeriod,
} from "../../src/modules/scheduling/services/schedule-service";
import {
  approveTimeOff,
  requestTimeOffForEmployee,
} from "../../src/modules/scheduling/services/time-off-service";
import { clearAuditEvents } from "../fixtures/audit-cleanup";
import { clearNotificationsFor } from "../fixtures/notification-cleanup";

loadLocalEnv();
pointAtTestDatabase();

// Separate from the other specs' data: spec files run in parallel, and each removes what
// it created by these markers when it finishes.
const EMAIL_DOMAIN = "scheduling-e2e.example.test";
const ROLE_PREFIX = "SCHEDULING_E2E_";
const EMPLOYEE_PREFIX = "SCHED-";
const PERIOD_PREFIX = "E2E ";

export type SchedulingAccount = { id: string; email: string; password: string };

async function mainLocation() {
  const [location] = await getDatabase()
    .select({ id: locations.id, organizationId: locations.organizationId })
    .from(locations)
    .where(eq(locations.locationCode, "MAIN"));

  return location!;
}

async function insertAccount(roleId: string): Promise<SchedulingAccount> {
  const database = getDatabase();
  const location = await mainLocation();
  const email = `user-${randomUUID()}@${EMAIL_DOMAIN}`;
  const password = randomBytes(24).toString("base64url");
  const [user] = await database
    .insert(users)
    .values({
      email,
      normalizedEmail: email,
      passwordHash: await hashPassword(password),
    })
    .returning({ id: users.id });

  await database
    .insert(userRoles)
    .values({ userId: user!.id, roleId, locationId: location.id });

  return { id: user!.id, email, password };
}

export async function createRoleAccount(
  roleCode: string,
): Promise<SchedulingAccount> {
  const [role] = await getDatabase()
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.code, roleCode));

  return insertAccount(role!.id);
}

export async function createPermissionAccount(
  codes: readonly PermissionCode[],
): Promise<SchedulingAccount> {
  const database = getDatabase();
  const { organizationId } = await mainLocation();
  const [role] = await database
    .insert(roles)
    .values({
      organizationId,
      code: `${ROLE_PREFIX}${randomUUID().replaceAll("-", "_").toUpperCase()}`,
      name: "Scheduling E2E fixture",
    })
    .returning({ id: roles.id });
  const rows = await database
    .select({ id: permissions.id })
    .from(permissions)
    .where(inArray(permissions.code, [...codes]));

  await database
    .insert(rolePermissions)
    .values(rows.map((row) => ({ roleId: role!.id, permissionId: row.id })));

  return insertAccount(role!.id);
}

export async function actorFor(account: SchedulingAccount): Promise<Actor> {
  const database = getDatabase();
  const location = await mainLocation();
  const context = await getUserAuthContext(database, account.id);

  return requirePermission(context!, {
    permission: "schedule.view",
    locationId: location.id,
  });
}

export async function findPositionId(code: string): Promise<string> {
  const [position] = await getDatabase()
    .select({ id: positions.id })
    .from(positions)
    .where(eq(positions.code, code));

  return position!.id;
}

/** An employee at MAIN holding this position, available all day every day. */
export async function createStaff(
  owner: SchedulingAccount,
  options: { positionCode?: string; available?: boolean } = {},
) {
  const database = getDatabase();
  const actor = await actorFor(owner);
  const lastName = `Staff-${randomUUID().slice(0, 8)}`;
  const { id } = await createEmployee(database, actor, {
    employeeNumber: `${EMPLOYEE_PREFIX}${randomUUID()}`.slice(0, 40),
    firstName: "Sam",
    middleName: null,
    lastName,
    preferredName: null,
    workEmail: null,
    hireDate: "2024-01-15",
    employmentType: "PART_TIME",
    positionId: await findPositionId(options.positionCode ?? "SERVER"),
  });

  if (options.available !== false) {
    for (const dayOfWeek of [0, 1, 2, 3, 4, 5, 6]) {
      await addRecurringAvailability(
        database,
        actor,
        { kind: "employee", employeeId: id },
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

  return { id, displayName: `Sam ${lastName}` };
}

export async function linkEmployee(
  employeeId: string,
  account: SchedulingAccount,
): Promise<void> {
  await getDatabase()
    .update(employees)
    .set({ userId: account.id })
    .where(eq(employees.id, employeeId));
}

let weekOffset = 0;

/**
 * A week of its own, so a published period here never overlaps another test's. Dates are
 * relative to today because swaps refuse started shifts and My schedule shows upcoming ones.
 */
export function nextWeek(): { monday: string; sunday: string; tuesday: string } {
  const today = new Date();
  const daysToMonday = (8 - today.getUTCDay()) % 7 || 7;
  const base =
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) +
    (daysToMonday + 14 + weekOffset * 7) * 86_400_000;

  weekOffset += 1;

  const date = (days: number) =>
    new Date(base + days * 86_400_000).toISOString().slice(0, 10);

  return { monday: date(0), tuesday: date(1), sunday: date(6) };
}

async function currentVersion(periodId: string): Promise<number> {
  const [row] = await getDatabase()
    .select({ version: schedulePeriods.version })
    .from(schedulePeriods)
    .where(eq(schedulePeriods.id, periodId));

  return row!.version;
}

export async function createDraft(
  owner: SchedulingAccount,
  week: { monday: string; sunday: string },
) {
  const period = await createPeriod(getDatabase(), await actorFor(owner), {
    name: `${PERIOD_PREFIX}${randomUUID().slice(0, 8)}`,
    startDate: week.monday,
    endDate: week.sunday,
  });

  return { id: period.id, name: period.name };
}

export async function addShift(
  owner: SchedulingAccount,
  periodId: string,
  options: {
    date: string;
    positionCode?: string;
    required?: number;
    start?: string;
    end?: string;
  },
) {
  const shift = await createShift(
    getDatabase(),
    await actorFor(owner),
    periodId,
    {
      positionId: await findPositionId(options.positionCode ?? "SERVER"),
      restaurantAreaId: null,
      shiftDate: options.date,
      startTime: options.start ?? "17:00",
      endTime: options.end ?? "22:00",
      requiredEmployeeCount: options.required ?? 1,
      courseOrStationNote: null,
      notes: null,
      priority: 0,
      expectedPeriodVersion: await currentVersion(periodId),
    },
  );

  return shift.id;
}

export async function assignStaff(
  owner: SchedulingAccount,
  periodId: string,
  shiftId: string,
  employeeId: string,
): Promise<void> {
  await assignEmployee(getDatabase(), await actorFor(owner), shiftId, {
    employeeId,
    notes: null,
    expectedPeriodVersion: await currentVersion(periodId),
  });
}

export async function publish(
  owner: SchedulingAccount,
  periodId: string,
): Promise<void> {
  await publishPeriod(getDatabase(), await actorFor(owner), periodId, {
    expectedVersion: await currentVersion(periodId),
  });
}

/** Approved time off for part of one day, entered by a manager. */
export async function approvedTimeOff(
  owner: SchedulingAccount,
  employeeId: string,
  options: { date: string; start: string; end: string },
): Promise<void> {
  const actor = await actorFor(owner);
  const { id } = await requestTimeOffForEmployee(getDatabase(), actor, employeeId, {
    startDate: options.date,
    startTime: options.start,
    endDate: options.date,
    endTime: options.end,
    requestType: "PERSONAL",
    reason: "E2E private reason",
    employeeNote: null,
  });

  await approveTimeOff(getDatabase(), actor, id, { managerNote: null, expectedVersion: 1 });
}

/** Removes only what this spec created, children first. */
export async function removeSchedulingE2eData(): Promise<void> {
  const database = getDatabase();
  const periods = await database
    .select({ id: schedulePeriods.id })
    .from(schedulePeriods)
    .where(like(schedulePeriods.name, `${PERIOD_PREFIX}%`));
  const periodIds = periods.map((row) => row.id);
  const shiftRows = periodIds.length
    ? await database
        .select({ id: shifts.id })
        .from(shifts)
        .where(inArray(shifts.schedulePeriodId, periodIds))
    : [];
  const shiftIds = shiftRows.map((row) => row.id);
  const assignmentRows = shiftIds.length
    ? await database
        .select({ id: shiftAssignments.id })
        .from(shiftAssignments)
        .where(inArray(shiftAssignments.shiftId, shiftIds))
    : [];
  const assignmentIds = assignmentRows.map((row) => row.id);
  const scheduledEmployees = await database
    .select({ id: employees.id })
    .from(employees)
    .where(like(employees.employeeNumber, `${EMPLOYEE_PREFIX}%`));
  const scheduledUsers = await database
    .select({ id: users.id })
    .from(users)
    .where(like(users.normalizedEmail, `%@${EMAIL_DOMAIN}`));

  // Phase 20: notifications reference periods, swaps and time off.
  await clearNotificationsFor(database, {
    schedulePeriodIds: periodIds,
    employeeIds: scheduledEmployees.map((row) => row.id),
    userIds: scheduledUsers.map((row) => row.id),
  });

  if (assignmentIds.length) {
    await database.delete(shiftSwapRequests).where(inArray(shiftSwapRequests.shiftAssignmentId, assignmentIds));
    await database.delete(shiftAssignments).where(inArray(shiftAssignments.id, assignmentIds));
  }

  if (periodIds.length) {
    await database.delete(scheduleGenerationRuns).where(inArray(scheduleGenerationRuns.schedulePeriodId, periodIds));
    await database.delete(shifts).where(inArray(shifts.schedulePeriodId, periodIds));
    await database.delete(schedulePeriods).where(inArray(schedulePeriods.id, periodIds));
  }

  await database.delete(staffingTemplateRequirements);
  await database.delete(staffingTemplates);

  const employeeRows = await database
    .select({ id: employees.id })
    .from(employees)
    .where(like(employees.employeeNumber, `${EMPLOYEE_PREFIX}%`));
  const employeeIds = employeeRows.map((row) => row.id);

  if (employeeIds.length) {
    await database.delete(timeOffRequests).where(inArray(timeOffRequests.employeeId, employeeIds));
    await database.delete(employeeSchedulingPreferences).where(inArray(employeeSchedulingPreferences.employeeId, employeeIds));
    await database.delete(employeeAvailabilityExceptions).where(inArray(employeeAvailabilityExceptions.employeeId, employeeIds));
    await database.delete(employeeAvailability).where(inArray(employeeAvailability.employeeId, employeeIds));
    await database.delete(employeeStatusHistory).where(inArray(employeeStatusHistory.employeeId, employeeIds));
    await database.delete(employeePositions).where(inArray(employeePositions.employeeId, employeeIds));
    await database.delete(employeeLocations).where(inArray(employeeLocations.employeeId, employeeIds));
    await clearAuditEvents(database, { employeeIds: employeeIds });
    await database.delete(employees).where(inArray(employees.id, employeeIds));
  }

  const accounts = await database
    .select({ id: users.id })
    .from(users)
    .where(like(users.normalizedEmail, `%@${EMAIL_DOMAIN}`));
  const userIds = accounts.map((row) => row.id);

  if (userIds.length) {
    await database.delete(userRoles).where(inArray(userRoles.userId, userIds));
    await clearAuditEvents(database, { userIds: userIds });
    await database.delete(users).where(inArray(users.id, userIds));
  }

  const fixtureRoles = await database
    .select({ id: roles.id })
    .from(roles)
    .where(like(roles.code, `${ROLE_PREFIX}%`));
  const roleIds = fixtureRoles.map((row) => row.id);

  if (roleIds.length) {
    await database.delete(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
    await database.delete(roles).where(inArray(roles.id, roleIds));
  }

  await closeDatabase();
}
