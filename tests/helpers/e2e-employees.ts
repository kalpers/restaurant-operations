import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { eq, inArray, like } from "drizzle-orm";

import { loadLocalEnv, pointAtTestDatabase } from "../../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../../src/db";
import {
  employeeAddresses,
  employeeCertifications,
  employeeDisciplinaryActions,
  employeeDocuments,
  employeeEmergencyContacts,
  employeeLocations,
  employeeNotes,
  employeePerformanceReviews,
  employeePositionCompensation,
  employeePositions,
  employees,
  employeeStatusHistory,
  locations,
  permissions,
  positions,
  rolePermissions,
  roles,
  userRoles,
  users,
} from "../../src/db/schema";
import { hashPassword } from "../../src/modules/auth/password";
import type { PermissionCode } from "../../src/modules/auth/permission-catalog";
import {
  getUserAuthContext,
  requirePermission,
} from "../../src/modules/auth/services/permission-service";
import { createEmployee } from "../../src/modules/employees/services/employee-service";
import { E2E_DOCUMENT_STORAGE_PATH } from "./e2e-storage";
import { clearAuditEvents } from "../fixtures/audit-cleanup";
import { clearStockSignalRows } from "./e2e-stock-signals";
import { clearNotificationsFor } from "../fixtures/notification-cleanup";

loadLocalEnv();
pointAtTestDatabase();

// Separate from auth.spec's domain: spec files run in parallel, and that spec removes
// every account on its own domain when it finishes.
const HR_E2E_EMAIL_DOMAIN = "hr-e2e.example.test";
const HR_E2E_ROLE_PREFIX = "HR_E2E_";
export const E2E_EMPLOYEE_PREFIX = "E2E-";

export type HrE2eAccount = { id: string; email: string; password: string };

async function findMainLocation() {
  const [location] = await getDatabase()
    .select({ id: locations.id, organizationId: locations.organizationId })
    .from(locations)
    .where(eq(locations.locationCode, "MAIN"));

  return location!;
}

async function insertAccount(roleId: string): Promise<HrE2eAccount> {
  const database = getDatabase();
  const location = await findMainLocation();
  const email = `user-${randomUUID()}@${HR_E2E_EMAIL_DOMAIN}`;
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

/** An account holding a seeded role, as a real manager or owner would. */
export async function createRoleAccount(roleCode: string): Promise<HrE2eAccount> {
  const [role] = await getDatabase()
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.code, roleCode));

  return insertAccount(role!.id);
}

/** An account holding exactly these permissions. */
export async function createPermissionAccount(
  codes: readonly PermissionCode[],
): Promise<HrE2eAccount> {
  const database = getDatabase();
  const { organizationId } = await findMainLocation();
  const [role] = await database
    .insert(roles)
    .values({
      organizationId,
      code: `${HR_E2E_ROLE_PREFIX}${randomUUID().replaceAll("-", "_").toUpperCase()}`,
      name: "HR E2E fixture",
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

export function uniqueEmployeeNumber(): string {
  return `${E2E_EMPLOYEE_PREFIX}${randomUUID()}`.slice(0, 40);
}

export async function findPositionId(code: string): Promise<string> {
  const [position] = await getDatabase()
    .select({ id: positions.id })
    .from(positions)
    .where(eq(positions.code, code));

  return position!.id;
}

/** Arranges an employee through the real service, acting as the given account. */
export async function createEmployeeRecord(
  account: HrE2eAccount,
  options: { positionCode?: string; firstName?: string } = {},
) {
  const database = getDatabase();
  const location = await findMainLocation();
  const context = await getUserAuthContext(database, account.id);
  const actor = requirePermission(context!, {
    permission: "employees.create",
    locationId: location.id,
  });
  const { id } = await createEmployee(database, actor, {
    employeeNumber: uniqueEmployeeNumber(),
    firstName: options.firstName ?? "Record",
    middleName: null,
    lastName: `Fixture-${randomUUID()}`,
    preferredName: null,
    workEmail: null,
    hireDate: "2024-01-15",
    employmentType: "PART_TIME",
    positionId: options.positionCode
      ? await findPositionId(options.positionCode)
      : null,
  });

  return id;
}

export async function linkEmployeeToUser(
  employeeId: string,
  userId: string,
): Promise<void> {
  await getDatabase()
    .update(employees)
    .set({ userId })
    .where(eq(employees.id, employeeId));
}

/** Removes only what this spec created, children first, plus its disposable files. */
export async function removeHrE2eData(): Promise<void> {
  const database = getDatabase();
  const employeeRows = await database
    .select({ id: employees.id })
    .from(employees)
    .where(like(employees.employeeNumber, `${E2E_EMPLOYEE_PREFIX}%`));
  const employeeIds = employeeRows.map((row) => row.id);

  if (employeeIds.length > 0) {
    await clearNotificationsFor(database, { employeeIds });
    await database.delete(employeeCertifications).where(inArray(employeeCertifications.employeeId, employeeIds));
    await database.delete(employeeDocuments).where(inArray(employeeDocuments.employeeId, employeeIds));
    await database.delete(employeeNotes).where(inArray(employeeNotes.employeeId, employeeIds));
    await database.delete(employeeDisciplinaryActions).where(inArray(employeeDisciplinaryActions.employeeId, employeeIds));
    await database.delete(employeePerformanceReviews).where(inArray(employeePerformanceReviews.employeeId, employeeIds));
    await database.delete(employeeStatusHistory).where(inArray(employeeStatusHistory.employeeId, employeeIds));
    await database.delete(employeePositionCompensation).where(inArray(employeePositionCompensation.employeeId, employeeIds));
    await database.delete(employeePositions).where(inArray(employeePositions.employeeId, employeeIds));
    await database.delete(employeeLocations).where(inArray(employeeLocations.employeeId, employeeIds));
    await database.delete(employeeAddresses).where(inArray(employeeAddresses.employeeId, employeeIds));
    await database.delete(employeeEmergencyContacts).where(inArray(employeeEmergencyContacts.employeeId, employeeIds));
    await clearAuditEvents(database, { employeeIds: employeeIds });
    await database.delete(employees).where(inArray(employees.id, employeeIds));
  }

  const accounts = await database
    .select({ id: users.id })
    .from(users)
    .where(like(users.normalizedEmail, `%@${HR_E2E_EMAIL_DOMAIN}`));
  const userIds = accounts.map((account) => account.id);

  if (userIds.length > 0) {
    await database.transaction((transaction) => clearStockSignalRows(transaction, { userIds }));
    await database.delete(userRoles).where(inArray(userRoles.userId, userIds));
    await clearAuditEvents(database, { userIds: userIds });
    await database.delete(users).where(inArray(users.id, userIds));
  }

  const fixtureRoles = await database
    .select({ id: roles.id })
    .from(roles)
    .where(like(roles.code, `${HR_E2E_ROLE_PREFIX}%`));
  const roleIds = fixtureRoles.map((role) => role.id);

  if (roleIds.length > 0) {
    await database.delete(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
    await database.delete(roles).where(inArray(roles.id, roleIds));
  }

  await closeDatabase();
  await rm(E2E_DOCUMENT_STORAGE_PATH, { recursive: true, force: true });
}
