import { randomUUID } from "node:crypto";

import type { Database } from "@/db";
import {
  certificationTypes,
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
  positions,
  scheduleGenerationRuns,
  schedulePeriods,
  schedulingRules,
  shiftAssignments,
  shifts,
  shiftSwapRequests,
  staffingTemplateRequirements,
  staffingTemplates,
  timeOffRequests,
  employeeAvailability,
  employeeAvailabilityExceptions,
  employeeSchedulingPreferences,
} from "@/db/schema";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { createEmployee } from "@/modules/employees/services/employee-service";

import {
  actorAt,
  createOrganizationFixture,
  createRoleFixture,
  createUserFixture,
} from "./auth-fixtures";

export const HIRE_DATE = "2024-01-15";
export const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

/**
 * A user holding exactly these permissions at one location, so a test can state what an
 * actor may do without depending on the seeded role matrix.
 */
export async function actorWith(
  database: Database,
  organization: { organizationId: string; locationA: string },
  granted: readonly PermissionCode[],
  locationId: string = organization.locationA,
): Promise<Actor> {
  const roleId = await createRoleFixture(
    database,
    organization.organizationId,
    [...granted, "menu.view"],
  );
  const user = await createUserFixture(database, {
    assignments: [{ roleId, locationId }],
  });

  return actorAt(database, user.id, locationId);
}

/** An organization with an actor holding every permission at its first location. */
export async function createHrScenario(database: Database) {
  const organization = await createOrganizationFixture(database);
  const ownerUser = await createUserFixture(database, {
    assignments: [
      { roleId: organization.ownerRole, locationId: organization.locationA },
      { roleId: organization.ownerRole, locationId: organization.locationB },
    ],
  });

  return {
    ...organization,
    ownerUser,
    owner: await actorAt(database, ownerUser.id, organization.locationA),
    ownerAtB: await actorAt(database, ownerUser.id, organization.locationB),
    server: await createPositionFixture(database, organization.organizationId, "SERVER"),
    bartender: await createPositionFixture(database, organization.organizationId, "BARTENDER"),
  };
}

export type HrScenario = Awaited<ReturnType<typeof createHrScenario>>;

export async function createPositionFixture(
  database: Database,
  organizationId: string,
  code = `POSITION_${randomUUID().replaceAll("-", "_").toUpperCase()}`,
): Promise<string> {
  const [position] = await database
    .insert(positions)
    .values({ organizationId, code, name: code })
    .returning({ id: positions.id });

  return position!.id;
}

export async function createCertificationTypeFixture(
  database: Database,
  organizationId: string,
  options: { expirationRequired?: boolean; active?: boolean } = {},
): Promise<string> {
  const [type] = await database
    .insert(certificationTypes)
    .values({
      organizationId,
      code: `CERT_${randomUUID().replaceAll("-", "_").toUpperCase()}`,
      name: "Fixture certification",
      expirationRequired: options.expirationRequired ?? false,
      active: options.active ?? true,
    })
    .returning({ id: certificationTypes.id });

  return type!.id;
}

export function uniqueEmployeeNumber(): string {
  return `E-${randomUUID()}`.slice(0, 40);
}

export function createEmployeeFixture(
  database: Database,
  actor: Actor,
  overrides: Partial<Parameters<typeof createEmployee>[2]> = {},
) {
  return createEmployee(database, actor, {
    employeeNumber: uniqueEmployeeNumber(),
    firstName: "Jane",
    middleName: null,
    lastName: "Smith",
    preferredName: null,
    workEmail: "jane@work.example.test",
    hireDate: HIRE_DATE,
    employmentType: "PART_TIME",
    positionId: null,
    ...overrides,
  });
}

/**
 * Employee rows reference users and locations with RESTRICT. Other test files clear
 * those tables, so each employee test file removes its rows when it finishes.
 */
export async function clearEmployeeData(database: Database): Promise<void> {
  await database.delete(shiftSwapRequests);
  await database.delete(shiftAssignments);
  await database.delete(scheduleGenerationRuns);
  await database.delete(shifts);
  await database.delete(schedulePeriods);
  await database.delete(staffingTemplateRequirements);
  await database.delete(staffingTemplates);
  await database.delete(schedulingRules);
  await database.delete(timeOffRequests);
  await database.delete(employeeSchedulingPreferences);
  await database.delete(employeeAvailabilityExceptions);
  await database.delete(employeeAvailability);
  await database.delete(employeeCertifications);
  await database.delete(employeeDocuments);
  await database.delete(employeeNotes);
  await database.delete(employeeDisciplinaryActions);
  await database.delete(employeePerformanceReviews);
  await database.delete(employeeStatusHistory);
  await database.delete(employeePositionCompensation);
  await database.delete(employeePositions);
  await database.delete(employeeLocations);
  await database.delete(employeeAddresses);
  await database.delete(employeeEmergencyContacts);
  await database.delete(employees);
  await database.delete(certificationTypes);
  await database.delete(positions);
}
