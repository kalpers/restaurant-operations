import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, inArray, like } from "drizzle-orm";

import { loadLocalEnv, pointAtTestDatabase } from "../../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../../src/db";
import {
  employeeLocations,
  employeePositions,
  employees,
  employeeStatusHistory,
  locations,
  permissions,
  positions,
  restaurantAreas,
  restaurantTables,
  rolePermissions,
  roles,
  schedulePeriods,
  serverSectionAssignments,
  serverSections,
  serverSectionTables,
  shiftAssignments,
  shifts,
  tableConditionHistory,
  tableSessionOverrides,
  tableSessions,
  tableSessionTables,
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
import { createTable } from "../../src/modules/restaurant/services/table-service";
import { clearAuditEvents } from "../fixtures/audit-cleanup";

loadLocalEnv();
pointAtTestDatabase();

// Separate from the other specs' data: spec files run in parallel, and each removes what
// it created by these markers when it finishes.
const EMAIL_DOMAIN = "restaurant-e2e.example.test";
const ROLE_PREFIX = "RESTAURANT_E2E_";
const EMPLOYEE_PREFIX = "REST-";
const PERIOD_PREFIX = "REST E2E ";
export const TABLE_PREFIX = "E2E-";
export const SECTION_PREFIX = "E2E_";

export type RestaurantAccount = { id: string; email: string; password: string };

async function mainLocation() {
  const [location] = await getDatabase()
    .select({ id: locations.id, organizationId: locations.organizationId })
    .from(locations)
    .where(eq(locations.locationCode, "MAIN"));

  return location!;
}

async function insertAccount(roleId: string): Promise<RestaurantAccount> {
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
): Promise<RestaurantAccount> {
  const [role] = await getDatabase()
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.code, roleCode));

  return insertAccount(role!.id);
}

export async function createPermissionAccount(
  codes: readonly PermissionCode[],
): Promise<RestaurantAccount> {
  const database = getDatabase();
  const { organizationId } = await mainLocation();
  const [role] = await database
    .insert(roles)
    .values({
      organizationId,
      code: `${ROLE_PREFIX}${randomUUID().replaceAll("-", "_").toUpperCase()}`,
      name: "Restaurant E2E fixture",
    })
    .returning({ id: roles.id });
  const rows = await database
    .select({ id: permissions.id })
    .from(permissions)
    .where(inArray(permissions.code, [...codes]));

  if (rows.length > 0) {
    await database
      .insert(rolePermissions)
      .values(rows.map((row) => ({ roleId: role!.id, permissionId: row.id })));
  }

  return insertAccount(role!.id);
}

async function ownerActor(owner: RestaurantAccount): Promise<Actor> {
  const location = await mainLocation();
  const context = await getUserAuthContext(getDatabase(), owner.id);

  return requirePermission(context!, {
    permission: "restaurant.view",
    locationId: location.id,
  });
}

async function areaIdOf(code: string): Promise<string> {
  const location = await mainLocation();
  const [area] = await getDatabase()
    .select({ id: restaurantAreas.id })
    .from(restaurantAreas)
    .where(
      and(
        eq(restaurantAreas.locationId, location.id),
        eq(restaurantAreas.code, code),
      ),
    );

  return area!.id;
}

/** A table only this test uses, so parallel specs and the seeded floor aren't touched. */
export async function createE2eTable(
  owner: RestaurantAccount,
  options: { capacity?: number; areaCode?: string } = {},
): Promise<{ id: string; tableNumber: string }> {
  const tableNumber = `${TABLE_PREFIX}${randomUUID().slice(0, 8)}`;
  const { id } = await createTable(getDatabase(), await ownerActor(owner), {
    restaurantAreaId: await areaIdOf(options.areaCode ?? "DINING_ROOM"),
    tableNumber,
    name: null,
    capacity: options.capacity ?? 4,
    minimumCapacity: null,
    sortOrder: null,
  });

  return { id, tableNumber };
}

/** An employee holding this position, with no login. */
export async function createStaff(
  owner: RestaurantAccount,
  positionCode = "SERVER",
) {
  const lastName = `Floor-${randomUUID().slice(0, 8)}`;
  const [position] = await getDatabase()
    .select({ id: positions.id })
    .from(positions)
    .where(eq(positions.code, positionCode));
  const { id } = await createEmployee(getDatabase(), await ownerActor(owner), {
    employeeNumber: `${EMPLOYEE_PREFIX}${randomUUID()}`.slice(0, 40),
    firstName: "Robin",
    middleName: null,
    lastName,
    preferredName: null,
    workEmail: null,
    hireDate: "2024-01-15",
    employmentType: "PART_TIME",
    positionId: position!.id,
  });

  return { id, positionId: position!.id, displayName: `Robin ${lastName}` };
}

/**
 * Written directly, because Scheduling refuses to schedule into the past and this needs a
 * shift running right now. One published period covers today for this spec, and it doesn't
 * collide with the Scheduling spec, whose weeks are far in the future.
 */
export async function putOnShift(
  owner: RestaurantAccount,
  staff: { id: string; positionId: string },
): Promise<void> {
  const database = getDatabase();
  const location = await mainLocation();
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const [inserted] = await database
    .insert(schedulePeriods)
    .values({
      locationId: location.id,
      name: `${PERIOD_PREFIX}${randomUUID().slice(0, 8)}`,
      startDate: today,
      endDate: today,
      status: "PUBLISHED",
      publishedAt: new Date(now),
      publishedByUserId: owner.id,
      createdByUserId: owner.id,
    })
    .onConflictDoNothing()
    .returning({ id: schedulePeriods.id });
  const [existing] = inserted
    ? []
    : await database
        .select({ id: schedulePeriods.id })
        .from(schedulePeriods)
        .where(like(schedulePeriods.name, `${PERIOD_PREFIX}%`));
  const periodId = (inserted ?? existing)!.id;
  const [shift] = await database
    .insert(shifts)
    .values({
      schedulePeriodId: periodId,
      locationId: location.id,
      positionId: staff.positionId,
      shiftDate: today,
      startAt: new Date(now - 3_600_000),
      endAt: new Date(now + 3_600_000),
    })
    .returning({ id: shifts.id });

  await database.insert(shiftAssignments).values({
    shiftId: shift!.id,
    employeeId: staff.id,
    assignmentSource: "MANUAL",
  });
}

export async function openSessionIdsAt(tableId: string): Promise<string[]> {
  const rows = await getDatabase()
    .select({
      sessionId: tableSessionTables.tableSessionId,
      leftAt: tableSessionTables.leftAt,
    })
    .from(tableSessionTables)
    .where(eq(tableSessionTables.restaurantTableId, tableId));

  return rows.filter((row) => row.leftAt === null).map((row) => row.sessionId);
}

export async function allSessionIdsAt(tableId: string): Promise<string[]> {
  const rows = await getDatabase()
    .select({ sessionId: tableSessionTables.tableSessionId })
    .from(tableSessionTables)
    .where(eq(tableSessionTables.restaurantTableId, tableId));

  return rows.map((row) => row.sessionId);
}

export async function removeRestaurantE2eData(): Promise<void> {
  const database = getDatabase();
  const tableRows = await database
    .select({ id: restaurantTables.id })
    .from(restaurantTables)
    .where(like(restaurantTables.tableNumber, `${TABLE_PREFIX}%`));
  const tableIds = tableRows.map((row) => row.id);
  const accounts = await database
    .select({ id: users.id })
    .from(users)
    .where(like(users.normalizedEmail, `%@${EMAIL_DOMAIN}`));
  const userIds = accounts.map((row) => row.id);
  const sessionRows = userIds.length
    ? await database
        .select({ id: tableSessions.id })
        .from(tableSessions)
        .where(inArray(tableSessions.createdByUserId, userIds))
    : [];
  const sessionIds = sessionRows.map((row) => row.id);

  if (sessionIds.length) {
    await database.delete(tableSessionOverrides).where(inArray(tableSessionOverrides.tableSessionId, sessionIds));
    await database.delete(tableSessionTables).where(inArray(tableSessionTables.tableSessionId, sessionIds));
    await database.delete(tableSessions).where(inArray(tableSessions.id, sessionIds));
  }

  const sectionRows = await database
    .select({ id: serverSections.id })
    .from(serverSections)
    .where(like(serverSections.code, `${SECTION_PREFIX}%`));
  const sectionIds = sectionRows.map((row) => row.id);

  if (sectionIds.length) {
    await database.delete(serverSectionAssignments).where(inArray(serverSectionAssignments.serverSectionId, sectionIds));
    await database.delete(serverSectionTables).where(inArray(serverSectionTables.serverSectionId, sectionIds));
    await database.delete(serverSections).where(inArray(serverSections.id, sectionIds));
  }

  if (tableIds.length) {
    await database.delete(serverSectionTables).where(inArray(serverSectionTables.restaurantTableId, tableIds));
    await database.delete(tableConditionHistory).where(inArray(tableConditionHistory.restaurantTableId, tableIds));
    await database.delete(restaurantTables).where(inArray(restaurantTables.id, tableIds));
  }

  // Tests also change the seeded floor's history only through their own users' actions.
  if (userIds.length) {
    await database.delete(tableConditionHistory).where(inArray(tableConditionHistory.changedByUserId, userIds));
  }

  const periods = await database
    .select({ id: schedulePeriods.id })
    .from(schedulePeriods)
    .where(like(schedulePeriods.name, `${PERIOD_PREFIX}%`));
  const periodIds = periods.map((row) => row.id);

  if (periodIds.length) {
    const shiftRows = await database
      .select({ id: shifts.id })
      .from(shifts)
      .where(inArray(shifts.schedulePeriodId, periodIds));
    const shiftIds = shiftRows.map((row) => row.id);

    if (shiftIds.length) {
      await database.delete(shiftAssignments).where(inArray(shiftAssignments.shiftId, shiftIds));
      await database.delete(shifts).where(inArray(shifts.id, shiftIds));
    }

    await database.delete(schedulePeriods).where(inArray(schedulePeriods.id, periodIds));
  }

  const employeeRows = await database
    .select({ id: employees.id })
    .from(employees)
    .where(like(employees.employeeNumber, `${EMPLOYEE_PREFIX}%`));
  const employeeIds = employeeRows.map((row) => row.id);

  if (employeeIds.length) {
    await database.delete(employeeStatusHistory).where(inArray(employeeStatusHistory.employeeId, employeeIds));
    await database.delete(employeePositions).where(inArray(employeePositions.employeeId, employeeIds));
    await database.delete(employeeLocations).where(inArray(employeeLocations.employeeId, employeeIds));
    await clearAuditEvents(database, { employeeIds: employeeIds });
    await database.delete(employees).where(inArray(employees.id, employeeIds));
  }

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
