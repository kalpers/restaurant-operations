import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { nextVersion } from "@/db/helpers/versioning";
import {
  restaurantAreas,
  restaurantTables,
  serverSectionAssignments,
  serverSections,
  serverSectionTables,
} from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { findEmployeeDisplayNames } from "@/modules/employees/queries/employee-display-names";
import {
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import type { AreaType } from "../types";
import { actorHolds, assertPermission, readLocationClock } from "./access";
import { checkServerAssignment } from "./server-eligibility-service";

/** The area must be here and be somewhere tables can be. */
async function assertSectionArea(
  executor: DatabaseExecutor,
  locationId: string,
  areaId: string | null,
): Promise<void> {
  if (!areaId) {
    return;
  }

  const [area] = await executor
    .select({ areaType: restaurantAreas.areaType })
    .from(restaurantAreas)
    .where(
      and(eq(restaurantAreas.id, areaId), eq(restaurantAreas.locationId, locationId)),
    );

  if (!area) {
    throw new NotFoundError("restaurant area");
  }

  if (area.areaType === "TAKEOUT") {
    throw new BusinessRuleError(
      "TAKEOUT_HAS_NO_TABLES",
      "Takeout isn't a seating area, so it can't have a section.",
    );
  }
}

async function lockSection(
  transaction: DatabaseTransaction,
  actor: Actor,
  sectionId: string,
) {
  const [section] = await transaction
    .select()
    .from(serverSections)
    .where(
      and(
        eq(serverSections.id, sectionId),
        eq(serverSections.locationId, actor.locationId),
      ),
    )
    .for("update");

  if (!section) {
    throw new NotFoundError("server section");
  }

  return section;
}

async function lockSectionAtVersion(
  transaction: DatabaseTransaction,
  actor: Actor,
  sectionId: string,
  expectedVersion: number,
) {
  const section = await lockSection(transaction, actor, sectionId);

  if (section.version !== expectedVersion) {
    throw new ConcurrencyError("server section", section.id);
  }

  return section;
}

async function activeSectionTables(
  executor: DatabaseExecutor,
  sectionId: string,
) {
  return executor
    .select({
      id: restaurantTables.id,
      restaurantAreaId: restaurantTables.restaurantAreaId,
      areaType: restaurantAreas.areaType,
    })
    .from(serverSectionTables)
    .innerJoin(
      restaurantTables,
      eq(restaurantTables.id, serverSectionTables.restaurantTableId),
    )
    .innerJoin(
      restaurantAreas,
      eq(restaurantAreas.id, restaurantTables.restaurantAreaId),
    )
    .where(
      and(
        eq(serverSectionTables.serverSectionId, sectionId),
        eq(serverSectionTables.active, true),
      ),
    );
}

export async function listSections(executor: DatabaseExecutor, actor: Actor) {
  if (
    !actorHolds(actor, "restaurant.sections.manage") &&
    !actorHolds(actor, "restaurant.view")
  ) {
    throw new AuthorizationError();
  }

  const clock = await readLocationClock(executor, actor.locationId, new Date());
  const sections = await executor
    .select({
      id: serverSections.id,
      code: serverSections.code,
      name: serverSections.name,
      restaurantAreaId: serverSections.restaurantAreaId,
      active: serverSections.active,
      version: serverSections.version,
    })
    .from(serverSections)
    .where(eq(serverSections.locationId, actor.locationId))
    .orderBy(asc(serverSections.code));
  const sectionIds = sections.map((section) => section.id);

  if (sectionIds.length === 0) {
    return [];
  }

  const memberships = await executor
    .select({
      sectionId: serverSectionTables.serverSectionId,
      tableId: restaurantTables.id,
      tableNumber: restaurantTables.tableNumber,
    })
    .from(serverSectionTables)
    .innerJoin(
      restaurantTables,
      eq(restaurantTables.id, serverSectionTables.restaurantTableId),
    )
    .where(
      and(
        inArray(serverSectionTables.serverSectionId, sectionIds),
        eq(serverSectionTables.active, true),
      ),
    )
    .orderBy(asc(restaurantTables.sortOrder), asc(restaurantTables.tableNumber));
  const assignments = await executor
    .select({
      id: serverSectionAssignments.id,
      sectionId: serverSectionAssignments.serverSectionId,
      employeeId: serverSectionAssignments.employeeId,
      version: serverSectionAssignments.version,
    })
    .from(serverSectionAssignments)
    .where(
      and(
        inArray(serverSectionAssignments.serverSectionId, sectionIds),
        eq(serverSectionAssignments.businessDate, clock.businessDate),
        isNull(serverSectionAssignments.effectiveTo),
      ),
    )
    .orderBy(desc(serverSectionAssignments.effectiveFrom));

  const serverNames = await findEmployeeDisplayNames(executor, {
    organizationId: actor.organizationId,
    employeeIds: assignments.map((row) => row.employeeId),
  });

  return sections.map((section) => {
    const assignment = assignments.find((row) => row.sectionId === section.id);

    return {
      ...section,
      tables: memberships
        .filter((row) => row.sectionId === section.id)
        .map(({ tableId, tableNumber }) => ({ tableId, tableNumber })),
      currentAssignment: assignment
        ? {
            id: assignment.id,
            employeeId: assignment.employeeId,
            version: assignment.version,
            displayName: serverNames.get(assignment.employeeId) ?? "",
          }
        : null,
    };
  });
}

const sectionCodeTaken = () =>
  new ConflictError(
    "SECTION_CODE_TAKEN",
    "Another section at this location already has that code.",
  );

export async function createSection(
  database: Database,
  actor: Actor,
  input: { code: string; name: string; restaurantAreaId: string | null },
): Promise<{ id: string; version: number }> {
  assertPermission(actor, "restaurant.sections.manage");

  await assertSectionArea(database, actor.locationId, input.restaurantAreaId);

  try {
    const [section] = await database
      .insert(serverSections)
      .values({ ...input, locationId: actor.locationId })
      .returning({ id: serverSections.id, version: serverSections.version });

    return section!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw sectionCodeTaken();
    }

    throw error;
  }
}

function assertTablesInArea(
  tables: readonly { restaurantAreaId: string }[],
  areaId: string | null,
): void {
  if (areaId && tables.some((table) => table.restaurantAreaId !== areaId)) {
    throw new BusinessRuleError(
      "TABLE_SECTION_AREA_MISMATCH",
      "Every table in this section must be in the section's area.",
    );
  }
}

/**
 * Changes configuration only. Active sessions keep the server they have. Deactivating ends
 * table memberships so those tables can join another section, and needs today's server to
 * have been ended first, so nobody's responsibility disappears silently.
 */
export async function updateSection(
  database: Database,
  actor: Actor,
  sectionId: string,
  input: {
    name: string;
    restaurantAreaId: string | null;
    active: boolean;
    expectedVersion: number;
  },
): Promise<{ id: string; version: number }> {
  assertPermission(actor, "restaurant.sections.manage");

  return withTransaction(database, async (transaction) => {
    await lockSectionAtVersion(
      transaction,
      actor,
      sectionId,
      input.expectedVersion,
    );
    await assertSectionArea(transaction, actor.locationId, input.restaurantAreaId);
    assertTablesInArea(
      await activeSectionTables(transaction, sectionId),
      input.restaurantAreaId,
    );

    if (!input.active) {
      const [open] = await transaction
        .select({ id: serverSectionAssignments.id })
        .from(serverSectionAssignments)
        .where(
          and(
            eq(serverSectionAssignments.serverSectionId, sectionId),
            isNull(serverSectionAssignments.effectiveTo),
            eq(
              serverSectionAssignments.businessDate,
              (await readLocationClock(transaction, actor.locationId, new Date()))
                .businessDate,
            ),
          ),
        );

      if (open) {
        throw new ConflictError(
          "SECTION_HAS_SERVER",
          "End this section's server assignment before deactivating it.",
        );
      }

      await transaction
        .update(serverSectionTables)
        .set({ active: false })
        .where(
          and(
            eq(serverSectionTables.serverSectionId, sectionId),
            eq(serverSectionTables.active, true),
          ),
        );
    }

    const [updated] = await transaction
      .update(serverSections)
      .set({
        name: input.name,
        restaurantAreaId: input.restaurantAreaId,
        active: input.active,
        version: nextVersion(serverSections.version),
      })
      .where(eq(serverSections.id, sectionId))
      .returning({ id: serverSections.id, version: serverSections.version });

    return updated!;
  });
}

/**
 * Sets exactly which tables a section holds. Removed tables keep their old row as history.
 * A table has one active section, which the database also enforces.
 */
export async function setSectionTables(
  database: Database,
  actor: Actor,
  sectionId: string,
  input: { tableIds: readonly string[]; expectedVersion: number },
): Promise<{ id: string; version: number }> {
  assertPermission(actor, "restaurant.sections.manage");

  const tableIds = [...new Set(input.tableIds)];

  try {
    return await withTransaction(database, async (transaction) => {
      const section = await lockSectionAtVersion(
        transaction,
        actor,
        sectionId,
        input.expectedVersion,
      );

      if (!section.active) {
        throw new BusinessRuleError(
          "SECTION_INACTIVE",
          "This section isn't active.",
        );
      }

      const tables = tableIds.length
        ? await transaction
            .select({
              id: restaurantTables.id,
              restaurantAreaId: restaurantTables.restaurantAreaId,
            })
            .from(restaurantTables)
            .where(
              and(
                inArray(restaurantTables.id, tableIds),
                eq(restaurantTables.locationId, actor.locationId),
              ),
            )
        : [];

      if (tables.length !== tableIds.length) {
        throw new NotFoundError("table");
      }

      assertTablesInArea(tables, section.restaurantAreaId);

      const current = await activeSectionTables(transaction, sectionId);
      const currentIds = current.map((table) => table.id);
      const removed = currentIds.filter((id) => !tableIds.includes(id));
      const added = tableIds.filter((id) => !currentIds.includes(id));

      if (removed.length > 0) {
        await transaction
          .update(serverSectionTables)
          .set({ active: false })
          .where(
            and(
              eq(serverSectionTables.serverSectionId, sectionId),
              eq(serverSectionTables.active, true),
              inArray(serverSectionTables.restaurantTableId, removed),
            ),
          );
      }

      if (added.length > 0) {
        await transaction.insert(serverSectionTables).values(
          added.map((restaurantTableId) => ({
            serverSectionId: sectionId,
            locationId: actor.locationId,
            restaurantTableId,
          })),
        );
      }

      const [updated] = await transaction
        .update(serverSections)
        .set({ version: nextVersion(serverSections.version) })
        .where(eq(serverSections.id, sectionId))
        .returning({ id: serverSections.id, version: serverSections.version });

      return updated!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "TABLE_IN_ANOTHER_SECTION",
        "One of those tables is already in another section.",
      );
    }

    throw error;
  }
}

/**
 * Puts a qualified server on a section from now, for this business date. It checks HR
 * facts and the published schedule, and grants no application permissions. A section's
 * current server must be ended first, so nothing is silently replaced.
 */
export async function assignServerToSection(
  database: Database,
  actor: Actor,
  sectionId: string,
  input: { employeeId: string; scheduleOverrideReason?: string | null },
): Promise<{ id: string; version: number; businessDate: string }> {
  assertPermission(actor, "restaurant.server.assign");

  try {
    return await withTransaction(database, async (transaction) => {
      const now = new Date();
      const section = await lockSection(transaction, actor, sectionId);

      if (!section.active) {
        throw new BusinessRuleError(
          "SECTION_INACTIVE",
          "This section isn't active.",
        );
      }

      const tables = await activeSectionTables(transaction, sectionId);
      const areaTypes = await sectionAreaTypes(
        transaction,
        section.restaurantAreaId,
        tables,
      );

      if (areaTypes.length === 0) {
        throw new BusinessRuleError(
          "SECTION_HAS_NO_AREA",
          "Give this section an area or some tables before assigning a server.",
        );
      }

      const { scheduleOverrideReason } = await checkServerAssignment(
        transaction,
        actor,
        {
          employeeId: input.employeeId,
          areaTypes,
          overrideReason: input.scheduleOverrideReason,
          instant: now,
        },
      );
      const clock = await readLocationClock(transaction, actor.locationId, now);
      const [assignment] = await transaction
        .insert(serverSectionAssignments)
        .values({
          serverSectionId: sectionId,
          employeeId: input.employeeId,
          businessDate: clock.businessDate,
          effectiveFrom: now,
          assignedByUserId: actor.userId,
          scheduleOverrideReason,
        })
        .returning({
          id: serverSectionAssignments.id,
          version: serverSectionAssignments.version,
          businessDate: serverSectionAssignments.businessDate,
        });

      return assignment!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "SECTION_ALREADY_ASSIGNED",
        "This section already has a server. End that assignment first.",
      );
    }

    throw error;
  }
}

async function sectionAreaTypes(
  transaction: DatabaseTransaction,
  areaId: string | null,
  tables: readonly { areaType: string }[],
): Promise<AreaType[]> {
  if (areaId) {
    const [area] = await transaction
      .select({ areaType: restaurantAreas.areaType })
      .from(restaurantAreas)
      .where(eq(restaurantAreas.id, areaId));

    return area ? [area.areaType as AreaType] : [];
  }

  return [...new Set(tables.map((table) => table.areaType as AreaType))];
}

/** Ends a section assignment now. Sessions already seated keep their server. */
export async function endSectionAssignment(
  database: Database,
  actor: Actor,
  assignmentId: string,
  input: { expectedVersion: number },
): Promise<{ id: string; version: number }> {
  assertPermission(actor, "restaurant.server.assign");

  return withTransaction(database, async (transaction) => {
    const [assignment] = await transaction
      .select({
        id: serverSectionAssignments.id,
        version: serverSectionAssignments.version,
        effectiveTo: serverSectionAssignments.effectiveTo,
        locationId: serverSections.locationId,
      })
      .from(serverSectionAssignments)
      .innerJoin(
        serverSections,
        eq(serverSections.id, serverSectionAssignments.serverSectionId),
      )
      .where(eq(serverSectionAssignments.id, assignmentId))
      .for("update", { of: serverSectionAssignments });

    if (!assignment || assignment.locationId !== actor.locationId) {
      throw new NotFoundError("section assignment");
    }

    if (assignment.effectiveTo) {
      throw new BusinessRuleError(
        "ASSIGNMENT_ALREADY_ENDED",
        "This assignment has already ended.",
      );
    }

    if (assignment.version !== input.expectedVersion) {
      throw new ConcurrencyError("section assignment", assignment.id);
    }

    const [updated] = await transaction
      .update(serverSectionAssignments)
      .set({
        effectiveTo: new Date(),
        endedByUserId: actor.userId,
        version: nextVersion(serverSectionAssignments.version),
      })
      .where(eq(serverSectionAssignments.id, assignmentId))
      .returning({
        id: serverSectionAssignments.id,
        version: serverSectionAssignments.version,
      });

    return updated!;
  });
}
