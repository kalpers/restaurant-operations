import { randomUUID } from "node:crypto";

import { eq, inArray, ne, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

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
  guestParties,
  guestPartyAllergies,
  guestProfileAllergies,
  guestProfileMerges,
  guestProfileNumberCounters,
  guestProfiles,
  locations,
  partyStatusHistory,
  reservationHoldOverrides,
  reservations,
  reservationTableAssignments,
  waitlistEntries,
  waitlistTableAssignments,
  positions,
  restaurantTables,
  scheduleGenerationRuns,
  schedulePeriods,
  schedulingRules,
  serverSectionAssignments,
  serverSections,
  serverSectionTables,
  shiftAssignments,
  shifts,
  shiftSwapRequests,
  staffingTemplateRequirements,
  staffingTemplates,
  tableConditionHistory,
  tableSessionOverrides,
  tableSessions,
  tableSessionTables,
  timeOffRequests,
  employeeAvailability,
  employeeAvailabilityExceptions,
  employeeSchedulingPreferences,
  tipDeclarations,
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
import { clearOrderData } from "./order-cleanup";
import { clearGuestMessagingData } from "./messaging-cleanup";
import { clearAuditEvents } from "./audit-cleanup";
import { clearPhase20Notifications } from "./notification-cleanup";

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
 * Phase 21: visit allergies, guest parties, and guest profiles with their allergies, merges and
 * counters. Profiles and merges are guarded against deletes, so the guards are lifted for this
 * transaction only (test database).
 */
export async function clearGuestProfileData(database: Database): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`ALTER TABLE guest_profiles DISABLE TRIGGER guest_profiles_guard`);
    await transaction.execute(sql`ALTER TABLE guest_profile_merges DISABLE TRIGGER guest_profile_merges_guard`);
    await transaction.delete(guestPartyAllergies);
    await transaction.delete(guestParties);
    await transaction.delete(guestProfileMerges);
    await transaction.delete(guestProfileAllergies);
    await transaction
      .update(guestProfiles)
      .set({ status: "ERASED", mergedIntoProfileId: null, erasedAt: new Date() })
      .where(eq(guestProfiles.status, "MERGED"));
    await transaction.delete(guestProfiles);
    await transaction.delete(guestProfileNumberCounters);
    await transaction.execute(sql`ALTER TABLE guest_profile_merges ENABLE TRIGGER guest_profile_merges_guard`);
    await transaction.execute(sql`ALTER TABLE guest_profiles ENABLE TRIGGER guest_profiles_guard`);
  });
}

/**
 * Everything a test created on the floor. The seeded floor at MAIN is kept, so a table
 * only goes if a fixture location owns it: tests run on their own fixture locations.
 */
export async function clearRestaurantData(database: Database): Promise<void> {
  // Orders reference table sessions, guest parties and employees.
  await clearOrderData(database);
  // Phase 22: messages reference reservations, waitlist entries and parties.
  await clearGuestMessagingData(database);
  await database.delete(reservationHoldOverrides);
  await database.delete(waitlistTableAssignments);
  await database.delete(waitlistEntries);
  await database.delete(reservationTableAssignments);
  await database.delete(reservations);
  await database.delete(tableSessionOverrides);
  await database.delete(tableSessionTables);
  await database.delete(tableSessions);
  await database.delete(partyStatusHistory);
  await clearGuestProfileData(database);
  await database.delete(serverSectionAssignments);

  const main = await database
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.locationCode, "MAIN"));
  const notMain = (column: AnyPgColumn) =>
    main.length > 0 ? ne(column, main[0]!.id) : undefined;
  const fixtureTables = database
    .select({ id: restaurantTables.id })
    .from(restaurantTables)
    .where(notMain(restaurantTables.locationId));

  await database
    .delete(tableConditionHistory)
    .where(inArray(tableConditionHistory.restaurantTableId, fixtureTables));
  await database
    .delete(serverSectionTables)
    .where(inArray(serverSectionTables.restaurantTableId, fixtureTables));
  await database.delete(restaurantTables).where(notMain(restaurantTables.locationId));
  await database.delete(serverSections).where(notMain(serverSections.locationId));
}

/**
 * Employee rows reference users and locations with RESTRICT. Other test files clear
 * those tables, so each employee test file removes its rows when it finishes.
 */
export async function clearEmployeeData(database: Database): Promise<void> {
  // Audit events reference employees with RESTRICT, so they go first.
  await clearAuditEvents(database);
  await clearRestaurantData(database);
  await clearPhase20Notifications(database);
  await database.delete(tipDeclarations);
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
