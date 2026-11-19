import { randomUUID } from "node:crypto";

import { and, eq, inArray, like } from "drizzle-orm";

import { closeDatabase, getDatabase } from "../../src/db";
import { employees, locations, locationSettings, positions, users } from "../../src/db/schema";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import { createEmployee } from "../../src/modules/employees/services/employee-service";

import { assignAt } from "./e2e-accounts";
import { createRoleAccount, type E2eScope, type OrdersAccount } from "./e2e-orders";

// Phase 32 E2E: a location of this spec's own, with an owner, a manager, and a server and a
// cook whose logins are linked to employees holding the SERVER and COOK positions there.
// Accounts are disabled afterwards; log entries and notes stay as records.

export const BRIEFINGS_SCOPE: E2eScope = {
  emailDomain: "briefings-e2e.example.test",
  rolePrefix: "BRIEFINGS_E2E_",
  tablePrefix: "BRF-",
};

export type BriefingsSetup = {
  locationId: string;
  owner: OrdersAccount;
  manager: OrdersAccount;
  server: OrdersAccount;
  cook: OrdersAccount;
  suffix: string;
};

async function account(roleCode: string, locationId: string): Promise<OrdersAccount> {
  const created = await createRoleAccount(roleCode, BRIEFINGS_SCOPE);

  await assignAt(created.id, roleCode, locationId);

  return created;
}

export async function createBriefingsSetup(): Promise<BriefingsSetup> {
  const database = getDatabase();
  const [main] = await database.select({ organizationId: locations.organizationId }).from(locations).where(eq(locations.locationCode, "MAIN"));
  const suffix = randomUUID().slice(0, 8);
  const [location] = await database
    .insert(locations)
    .values({
      organizationId: main!.organizationId,
      name: `Briefings ${suffix}`,
      locationCode: `BRF_${randomUUID()}`,
      timezone: "America/Detroit",
    })
    .returning({ id: locations.id });
  const locationId = location!.id;

  await database.insert(locationSettings).values({ locationId, cashDrawerRequired: false });

  const owner = await account("OWNER", locationId);
  const manager = await account("MANAGER", locationId);
  const server = await account("SERVER", locationId);
  const cook = await account("COOK", locationId);
  const context = await getUserAuthContext(database, owner.id);
  const ownerActor = requirePermission(context!, { permission: "employees.create", locationId });

  for (const [staff, positionCode, firstName] of [
    [server, "SERVER", "Sam"],
    [cook, "COOK", "Casey"],
  ] as const) {
    const [position] = await database
      .select({ id: positions.id })
      .from(positions)
      .where(and(eq(positions.organizationId, main!.organizationId), eq(positions.code, positionCode)));
    const { id } = await createEmployee(database, ownerActor, {
      employeeNumber: `BRF-${randomUUID()}`.slice(0, 40),
      firstName,
      middleName: null,
      lastName: `Briefing-${suffix}`,
      preferredName: null,
      workEmail: null,
      hireDate: "2024-01-15",
      employmentType: "PART_TIME",
      positionId: position!.id,
    });

    await database.update(employees).set({ userId: staff.id }).where(eq(employees.id, id));
  }

  return { locationId, owner, manager, server, cook, suffix };
}

export async function disableBriefingsAccounts(): Promise<void> {
  const database = getDatabase();
  const accounts = await database.select({ id: users.id }).from(users).where(like(users.normalizedEmail, `%@${BRIEFINGS_SCOPE.emailDomain}`));

  if (accounts.length > 0) {
    await database
      .update(users)
      .set({ active: false, disabledAt: new Date() })
      .where(inArray(users.id, accounts.map((row) => row.id)));
  }

  await closeDatabase();
}
