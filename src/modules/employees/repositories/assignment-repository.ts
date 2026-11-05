import { and, asc, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";

import {
  employeeLocations,
  employeePositions,
  locations,
  positions,
} from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

export function findLocationAssignments(
  executor: DatabaseExecutor,
  employeeId: string,
  options: { includeEnded: boolean },
) {
  return executor
    .select({
      id: employeeLocations.id,
      locationId: employeeLocations.locationId,
      locationName: locations.name,
      primaryLocation: employeeLocations.primaryLocation,
      effectiveFrom: employeeLocations.effectiveFrom,
      effectiveTo: employeeLocations.effectiveTo,
      active: employeeLocations.active,
    })
    .from(employeeLocations)
    .innerJoin(locations, eq(locations.id, employeeLocations.locationId))
    .where(
      and(
        eq(employeeLocations.employeeId, employeeId),
        options.includeEnded ? undefined : eq(employeeLocations.active, true),
      ),
    )
    .orderBy(desc(employeeLocations.active), desc(employeeLocations.effectiveFrom));
}

export function findPositionAssignments(
  executor: DatabaseExecutor,
  employeeId: string,
  options: { includeEnded: boolean },
) {
  return executor
    .select({
      id: employeePositions.id,
      positionId: employeePositions.positionId,
      positionName: positions.name,
      locationId: employeePositions.locationId,
      locationName: locations.name,
      primaryPosition: employeePositions.primaryPosition,
      effectiveFrom: employeePositions.effectiveFrom,
      effectiveTo: employeePositions.effectiveTo,
      active: employeePositions.active,
    })
    .from(employeePositions)
    .innerJoin(positions, eq(positions.id, employeePositions.positionId))
    .innerJoin(locations, eq(locations.id, employeePositions.locationId))
    .where(
      and(
        eq(employeePositions.employeeId, employeeId),
        options.includeEnded ? undefined : eq(employeePositions.active, true),
      ),
    )
    .orderBy(desc(employeePositions.active), asc(positions.name));
}

export async function insertLocationAssignment(
  executor: DatabaseExecutor,
  values: {
    employeeId: string;
    locationId: string;
    primaryLocation: boolean;
    effectiveFrom: string;
  },
) {
  const [row] = await executor
    .insert(employeeLocations)
    .values(values)
    .returning({ id: employeeLocations.id });

  if (!row) {
    throw new Error("Employee location insert returned no row.");
  }

  return row;
}

export async function insertPositionAssignment(
  executor: DatabaseExecutor,
  values: {
    employeeId: string;
    positionId: string;
    locationId: string;
    primaryPosition: boolean;
    effectiveFrom: string;
  },
) {
  const [row] = await executor
    .insert(employeePositions)
    .values(values)
    .returning({ id: employeePositions.id });

  if (!row) {
    throw new Error("Employee position insert returned no row.");
  }

  return row;
}

export async function findLocationAssignmentById(
  executor: DatabaseExecutor,
  employeeId: string,
  assignmentId: string,
) {
  const [row] = await executor
    .select({
      id: employeeLocations.id,
      locationId: employeeLocations.locationId,
      primaryLocation: employeeLocations.primaryLocation,
      effectiveFrom: employeeLocations.effectiveFrom,
      active: employeeLocations.active,
    })
    .from(employeeLocations)
    .where(
      and(
        eq(employeeLocations.id, assignmentId),
        eq(employeeLocations.employeeId, employeeId),
      ),
    );

  return row;
}

export async function findPositionAssignmentById(
  executor: DatabaseExecutor,
  employeeId: string,
  assignmentId: string,
) {
  const [row] = await executor
    .select({
      id: employeePositions.id,
      locationId: employeePositions.locationId,
      primaryPosition: employeePositions.primaryPosition,
      effectiveFrom: employeePositions.effectiveFrom,
      active: employeePositions.active,
    })
    .from(employeePositions)
    .where(
      and(
        eq(employeePositions.id, assignmentId),
        eq(employeePositions.employeeId, employeeId),
      ),
    );

  return row;
}

export async function findActiveLocationAssignmentAt(
  executor: DatabaseExecutor,
  employeeId: string,
  locationId: string,
) {
  const [row] = await executor
    .select({
      id: employeeLocations.id,
      effectiveFrom: employeeLocations.effectiveFrom,
    })
    .from(employeeLocations)
    .where(
      and(
        eq(employeeLocations.employeeId, employeeId),
        eq(employeeLocations.locationId, locationId),
        eq(employeeLocations.active, true),
      ),
    );

  return row;
}

export async function hasActivePositionsAtLocation(
  executor: DatabaseExecutor,
  employeeId: string,
  locationId: string,
): Promise<boolean> {
  const rows = await executor
    .select({ id: employeePositions.id })
    .from(employeePositions)
    .where(
      and(
        eq(employeePositions.employeeId, employeeId),
        eq(employeePositions.locationId, locationId),
        eq(employeePositions.active, true),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/** At any location, because a wage isn't location-specific. Ended rows still count. */
export async function hasPositionEffectiveOn(
  executor: DatabaseExecutor,
  input: { employeeId: string; positionId: string; date: string },
): Promise<boolean> {
  const rows = await executor
    .select({ id: employeePositions.id })
    .from(employeePositions)
    .where(
      and(
        eq(employeePositions.employeeId, input.employeeId),
        eq(employeePositions.positionId, input.positionId),
        lte(employeePositions.effectiveFrom, input.date),
        or(
          isNull(employeePositions.effectiveTo),
          gte(employeePositions.effectiveTo, input.date),
        ),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

export async function endLocationAssignmentRow(
  executor: DatabaseExecutor,
  assignmentId: string,
  effectiveTo: string,
): Promise<void> {
  await executor
    .update(employeeLocations)
    .set({ effectiveTo, active: false, primaryLocation: false })
    .where(eq(employeeLocations.id, assignmentId));
}

export async function endPositionAssignmentRow(
  executor: DatabaseExecutor,
  assignmentId: string,
  effectiveTo: string,
): Promise<void> {
  await executor
    .update(employeePositions)
    .set({ effectiveTo, active: false, primaryPosition: false })
    .where(eq(employeePositions.id, assignmentId));
}

export async function clearPrimaryLocation(
  executor: DatabaseExecutor,
  employeeId: string,
): Promise<void> {
  await executor
    .update(employeeLocations)
    .set({ primaryLocation: false })
    .where(
      and(
        eq(employeeLocations.employeeId, employeeId),
        eq(employeeLocations.primaryLocation, true),
      ),
    );
}

export async function setPrimaryLocationRow(
  executor: DatabaseExecutor,
  assignmentId: string,
): Promise<void> {
  await executor
    .update(employeeLocations)
    .set({ primaryLocation: true })
    .where(eq(employeeLocations.id, assignmentId));
}

export async function clearPrimaryPositionAt(
  executor: DatabaseExecutor,
  employeeId: string,
  locationId: string,
): Promise<void> {
  await executor
    .update(employeePositions)
    .set({ primaryPosition: false })
    .where(
      and(
        eq(employeePositions.employeeId, employeeId),
        eq(employeePositions.locationId, locationId),
        eq(employeePositions.primaryPosition, true),
      ),
    );
}

export async function setPrimaryPositionRow(
  executor: DatabaseExecutor,
  assignmentId: string,
): Promise<void> {
  await executor
    .update(employeePositions)
    .set({ primaryPosition: true })
    .where(eq(employeePositions.id, assignmentId));
}

/**
 * Ends everything still active. A row that hasn't started closes on its own start
 * date, because an end can't precede a start.
 */
export async function endAllActiveAssignments(
  executor: DatabaseExecutor,
  employeeId: string,
  terminationDate: string,
): Promise<void> {
  await executor
    .update(employeePositions)
    .set({
      effectiveTo: sql`GREATEST(${employeePositions.effectiveFrom}, ${terminationDate}::date)`,
      active: false,
      primaryPosition: false,
    })
    .where(
      and(
        eq(employeePositions.employeeId, employeeId),
        eq(employeePositions.active, true),
      ),
    );

  await executor
    .update(employeeLocations)
    .set({
      effectiveTo: sql`GREATEST(${employeeLocations.effectiveFrom}, ${terminationDate}::date)`,
      active: false,
      primaryLocation: false,
    })
    .where(
      and(
        eq(employeeLocations.employeeId, employeeId),
        eq(employeeLocations.active, true),
      ),
    );
}
