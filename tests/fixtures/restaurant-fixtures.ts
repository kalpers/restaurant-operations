import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { Database } from "@/db";
import {
  restaurantAreas,
  restaurantTables,
  schedulePeriods,
  shiftAssignments,
  shifts,
  tableConditionHistory,
  tableSessionOverrides,
  tableSessions,
  tableSessionTables,
} from "@/db/schema";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import { createTable } from "@/modules/restaurant/services/table-service";

import {
  actorWith,
  createEmployeeFixture,
  createHrScenario,
  createPositionFixture,
} from "./employee-fixtures";

async function areaFixture(
  database: Database,
  locationId: string,
  code: string,
  areaType: "DINING" | "BAR" | "TAKEOUT",
): Promise<string> {
  const [area] = await database
    .insert(restaurantAreas)
    .values({ locationId, code, name: code, areaType })
    .returning({ id: restaurantAreas.id });

  return area!.id;
}

/** An organization with an all-permissions owner, areas, and the positions the policy names. */
export async function createRestaurantScenario(database: Database) {
  const scenario = await createHrScenario(database);

  return {
    ...scenario,
    dining: await areaFixture(database, scenario.locationA, "DINING_ROOM", "DINING"),
    bar: await areaFixture(database, scenario.locationA, "BAR", "BAR"),
    takeout: await areaFixture(database, scenario.locationA, "TAKEOUT", "TAKEOUT"),
    diningAtB: await areaFixture(database, scenario.locationB, "DINING_ROOM", "DINING"),
    waitStaff: await createPositionFixture(database, scenario.organizationId, "WAIT_STAFF"),
    cook: await createPositionFixture(database, scenario.organizationId, "COOK"),
    hostPosition: await createPositionFixture(database, scenario.organizationId, "HOST"),
  };
}

export type RestaurantScenario = Awaited<ReturnType<typeof createRestaurantScenario>>;

export const HOST_PERMISSIONS: readonly PermissionCode[] = [
  "restaurant.view",
  "restaurant.seat",
  "restaurant.move",
  "restaurant.complete-session",
  "restaurant.clean-table",
  "restaurant.server.assign",
];

export function hostActor(database: Database, scenario: RestaurantScenario) {
  return actorWith(database, scenario, HOST_PERMISSIONS);
}

export async function tableFixture(
  database: Database,
  scenario: RestaurantScenario,
  options: { areaId?: string; capacity?: number; tableNumber?: string } = {},
): Promise<string> {
  const { id } = await createTable(database, scenario.owner, {
    restaurantAreaId: options.areaId ?? scenario.dining,
    tableNumber: options.tableNumber ?? `T-${randomUUID().slice(0, 8)}`,
    name: null,
    capacity: options.capacity ?? 4,
    minimumCapacity: null,
    sortOrder: null,
  });

  return id;
}

/** An employee holding one position at location A, with no shift unless one is added. */
export async function serverFixture(
  database: Database,
  scenario: RestaurantScenario,
  positionId: string | null = scenario.server,
): Promise<string> {
  const { id } = await createEmployeeFixture(database, scenario.owner, { positionId });

  return id;
}

/**
 * Written directly, because the Scheduling services refuse to schedule into the past and
 * this needs a shift running right now. Its own rules are tested in Scheduling.
 */
export async function putOnShift(
  database: Database,
  scenario: RestaurantScenario,
  employeeId: string,
  positionId: string,
  options: {
    periodStatus?: "PUBLISHED" | "DRAFT" | "ARCHIVED";
    startsInMinutes?: number;
    endsInMinutes?: number;
    assignmentEnded?: boolean;
    cancelled?: boolean;
    locationId?: string;
  } = {},
): Promise<void> {
  const now = Date.now();
  const status = options.periodStatus ?? "PUBLISHED";
  const locationId = options.locationId ?? scenario.locationA;
  const today = new Date(now).toISOString().slice(0, 10);
  const published = status !== "DRAFT";
  // Only one published period can cover a date, so a second shift today reuses it.
  const [inserted] = await database
    .insert(schedulePeriods)
    .values({
      locationId,
      name: `Fixture ${randomUUID().slice(0, 8)}`,
      startDate: today,
      endDate: today,
      status,
      publishedAt: published ? new Date(now) : null,
      publishedByUserId: published ? scenario.owner.userId : null,
      archivedAt: status === "ARCHIVED" ? new Date(now) : null,
      createdByUserId: scenario.owner.userId,
    })
    .onConflictDoNothing()
    .returning({ id: schedulePeriods.id });
  const [existing] = inserted
    ? []
    : await database
        .select({ id: schedulePeriods.id })
        .from(schedulePeriods)
        .where(
          and(
            eq(schedulePeriods.locationId, locationId),
            eq(schedulePeriods.status, "PUBLISHED"),
          ),
        );
  const period = inserted ?? existing;
  const [shift] = await database
    .insert(shifts)
    .values({
      schedulePeriodId: period!.id,
      locationId,
      positionId,
      shiftDate: today,
      startAt: new Date(now + (options.startsInMinutes ?? -60) * 60_000),
      endAt: new Date(now + (options.endsInMinutes ?? 60) * 60_000),
      cancelledAt: options.cancelled ? new Date(now) : null,
    })
    .returning({ id: shifts.id });

  await database.insert(shiftAssignments).values({
    shiftId: shift!.id,
    employeeId,
    assignmentSource: "MANUAL",
    status: options.assignmentEnded ? "REMOVED" : "ACTIVE",
    endedAt: options.assignmentEnded ? new Date(now) : null,
  });
}

export async function tableRow(database: Database, tableId: string) {
  const [row] = await database
    .select()
    .from(restaurantTables)
    .where(eq(restaurantTables.id, tableId));

  return row!;
}

export async function sessionRow(database: Database, sessionId: string) {
  const [row] = await database
    .select()
    .from(tableSessions)
    .where(eq(tableSessions.id, sessionId));

  return row!;
}

export function sessionMemberships(database: Database, sessionId: string) {
  return database
    .select()
    .from(tableSessionTables)
    .where(eq(tableSessionTables.tableSessionId, sessionId));
}

export function sessionOverrides(database: Database, sessionId: string) {
  return database
    .select()
    .from(tableSessionOverrides)
    .where(eq(tableSessionOverrides.tableSessionId, sessionId));
}

export function conditionHistory(database: Database, tableId: string) {
  return database
    .select()
    .from(tableConditionHistory)
    .where(eq(tableConditionHistory.restaurantTableId, tableId))
    .orderBy(tableConditionHistory.createdAt);
}
