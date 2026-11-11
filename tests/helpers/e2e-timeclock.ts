import { randomUUID } from "node:crypto";

import { and, eq, inArray, like } from "drizzle-orm";

import { closeDatabase, getDatabase } from "../../src/db";
import {
  employeeLocations,
  employeePositions,
  employees,
  idempotencyRecords,
  locations,
  locationSettings,
  positions,
  timeEntries,
  tipPoolRulePositions,
  tipPoolRules,
  users,
} from "../../src/db/schema";
import { businessDateOf } from "../../src/shared/time/business-date-service";
import { createRoleAccount, type E2eScope, type OrdersAccount } from "./e2e-orders";

// Phase 18 E2E helpers. Setup writes rows directly (as the services would); every step a
// spec checks is done on screen. Accounts are disabled, not deleted, at the end: time entries
// and tip distributions keep referencing the users who recorded them.

export const LABOR_SCOPE: E2eScope = {
  emailDomain: "labor-e2e.example.test",
  rolePrefix: "LABOR_E2E_",
  tablePrefix: "LAB-",
};

export const laborAccount = (roleCode: string) => createRoleAccount(roleCode, LABOR_SCOPE);

const DETROIT = { timeZone: "America/Detroit", businessDayCutoff: "04:00:00" };

export function businessDateAt(instant: Date): string {
  return businessDateOf(instant, DETROIT);
}

/** "YYYY-MM-DDTHH:MM" in Detroit time, for a datetime-local input (specs run in that zone). */
export function detroitLocal(instant: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: DETROIT.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * A location of the spec's own, so time entries and tip distributions never meet other specs'
 * open checks on MAIN. It uses its own code prefix: `auth.spec` deletes `E2E_` locations, and
 * this one keeps rows that reference it. A new location doesn't require a cash drawer.
 */
export async function createLaborLocation(): Promise<string> {
  const database = getDatabase();
  const [main] = await database
    .select({ organizationId: locations.organizationId })
    .from(locations)
    .where(eq(locations.locationCode, "MAIN"));
  const [location] = await database
    .insert(locations)
    .values({
      organizationId: main!.organizationId,
      name: `Labor ${randomUUID().slice(0, 8)}`,
      locationCode: `LAB_${randomUUID()}`,
      timezone: DETROIT.timeZone,
    })
    .returning({ id: locations.id });

  await database.insert(locationSettings).values({ locationId: location!.id, cashDrawerRequired: false });

  return location!.id;
}

async function positionId(code: string): Promise<string> {
  const [row] = await getDatabase().select({ id: positions.id }).from(positions).where(eq(positions.code, code));

  return row!.id;
}

async function organizationOf(locationId: string): Promise<string> {
  const [row] = await getDatabase()
    .select({ organizationId: locations.organizationId })
    .from(locations)
    .where(eq(locations.id, locationId));

  return row!.organizationId;
}

/** An ACTIVE employee at the location holding the position, optionally linked to a login. */
export async function createWorker(input: {
  locationId: string;
  positionCode?: string;
  userId?: string | null;
  firstName?: string;
}): Promise<{ id: string; employeeNumber: string; name: string }> {
  const database = getDatabase();
  const employeeNumber = `LAB-${randomUUID().slice(0, 8)}`;
  const firstName = input.firstName ?? "Lee";
  const lastName = `Clock-${randomUUID().slice(0, 6)}`;
  const [employee] = await database
    .insert(employees)
    .values({
      organizationId: await organizationOf(input.locationId),
      userId: input.userId ?? null,
      employeeNumber,
      firstName,
      lastName,
      hireDate: "2024-01-15",
      employmentType: "PART_TIME",
      primaryLocationId: input.locationId,
    })
    .returning({ id: employees.id });

  await database.insert(employeeLocations).values({
    employeeId: employee!.id,
    locationId: input.locationId,
    primaryLocation: true,
    effectiveFrom: "2024-01-15",
  });
  await database.insert(employeePositions).values({
    employeeId: employee!.id,
    positionId: await positionId(input.positionCode ?? "SERVER"),
    locationId: input.locationId,
    primaryPosition: true,
    effectiveFrom: "2024-01-15",
  });

  return { id: employee!.id, employeeNumber, name: `${firstName} ${lastName}` };
}

/** An entry left OPEN from an earlier business date: a missed clock-out. */
export async function insertOpenEntry(input: {
  locationId: string;
  employeeId: string;
  byUserId: string;
  clockInAt: Date;
  positionCode?: string;
}): Promise<string> {
  const database = getDatabase();
  const organizationId = await organizationOf(input.locationId);
  const [record] = await database
    .insert(idempotencyRecords)
    .values({
      organizationId,
      scope: "timeclock.clock-in",
      idempotencyKey: `e2e_${randomUUID().replaceAll("-", "")}`,
      actorUserId: input.byUserId,
      requestFingerprint: "e2e-fixture",
      response: {},
    })
    .returning({ id: idempotencyRecords.id });
  const [entry] = await database
    .insert(timeEntries)
    .values({
      organizationId,
      locationId: input.locationId,
      employeeId: input.employeeId,
      positionId: await positionId(input.positionCode ?? "SERVER"),
      businessDate: businessDateAt(input.clockInAt),
      clockInAt: input.clockInAt,
      clockInRecordedAt: input.clockInAt,
      clockInSource: "MANAGER",
      clockInByUserId: input.byUserId,
      clockInIdempotencyRecordId: record!.id,
    })
    .returning({ id: timeEntries.id });

  return entry!.id;
}

/**
 * Makes sure the location pools tips with Server at 10 points, without disturbing a rule
 * another spec already set up (it only adds Server if missing and activates the rule).
 */
export async function ensureServerTipPool(locationId: string): Promise<void> {
  const database = getDatabase();

  await database
    .insert(tipPoolRules)
    .values({ organizationId: await organizationOf(locationId), locationId, active: true })
    .onConflictDoNothing({ target: tipPoolRules.locationId });

  const [rule] = await database.select().from(tipPoolRules).where(eq(tipPoolRules.locationId, locationId));

  if (!rule!.active) {
    await database.update(tipPoolRules).set({ active: true }).where(eq(tipPoolRules.id, rule!.id));
  }

  await database
    .insert(tipPoolRulePositions)
    .values({ ruleId: rule!.id, positionId: await positionId("SERVER"), points: "10" })
    .onConflictDoNothing();
  await database
    .update(tipPoolRulePositions)
    .set({ active: true })
    .where(and(eq(tipPoolRulePositions.ruleId, rule!.id), eq(tipPoolRulePositions.positionId, await positionId("SERVER"))));
}

export async function disableLaborAccounts(): Promise<void> {
  const database = getDatabase();
  const accounts = await database
    .select({ id: users.id })
    .from(users)
    .where(like(users.normalizedEmail, `%@${LABOR_SCOPE.emailDomain}`));

  if (accounts.length > 0) {
    await database
      .update(users)
      .set({ active: false, disabledAt: new Date() })
      .where(inArray(users.id, accounts.map((row) => row.id)));
  }

  await closeDatabase();
}

export type { OrdersAccount };
