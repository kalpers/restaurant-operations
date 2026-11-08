import { and, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { nextVersion } from "@/db/helpers/versioning";
import {
  restaurantAreas,
  restaurantTables,
  serverSections,
  serverSectionTables,
  tableConditionHistory,
} from "@/db/schema";
import {
  withTransaction,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import {
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import {
  findOccupyingSessions,
  listTablesAtLocation,
  lockTables,
  writeTableCondition,
  type TableRow,
} from "../repositories/table-repository";
import type { TableCondition } from "../types";
import { actorHolds, assertPermission } from "./access";

type TableInput = {
  restaurantAreaId: string;
  tableNumber: string;
  name: string | null;
  capacity: number;
  minimumCapacity: number | null;
  sortOrder: number | null;
};

const tableNumberTaken = () =>
  new ConflictError(
    "TABLE_NUMBER_TAKEN",
    "Another table at this location already has that number.",
  );

function assertMinimumCapacity(input: TableInput): void {
  if (input.minimumCapacity !== null && input.minimumCapacity > input.capacity) {
    throw new BusinessRuleError(
      "MINIMUM_CAPACITY_TOO_HIGH",
      "Minimum capacity can't be above capacity.",
    );
  }
}

/** The area must be here, and it can't be Takeout: Takeout is never a physical table. */
async function assertTableArea(
  executor: DatabaseExecutor,
  locationId: string,
  areaId: string,
): Promise<void> {
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
      "Takeout isn't a seating area, so it can't have tables.",
    );
  }
}

export async function listTablesForConfiguration(
  executor: DatabaseExecutor,
  actor: Actor,
): Promise<TableRow[]> {
  if (
    !actorHolds(actor, "restaurant.tables.manage") &&
    !actorHolds(actor, "restaurant.view")
  ) {
    throw new AuthorizationError();
  }

  return listTablesAtLocation(executor, actor.locationId);
}

export async function createTable(
  database: Database,
  actor: Actor,
  input: TableInput,
): Promise<{ id: string; version: number }> {
  assertPermission(actor, "restaurant.tables.manage");
  assertMinimumCapacity(input);

  try {
    return await withTransaction(database, async (transaction) => {
      await assertTableArea(transaction, actor.locationId, input.restaurantAreaId);

      const [table] = await transaction
        .insert(restaurantTables)
        .values({
          ...input,
          locationId: actor.locationId,
          sortOrder: input.sortOrder ?? 0,
        })
        .returning({ id: restaurantTables.id, version: restaurantTables.version });

      await transaction.insert(tableConditionHistory).values({
        restaurantTableId: table!.id,
        condition: "CLEAN",
        reason: "Table created",
        changedByUserId: actor.userId,
      });

      return table!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw tableNumberTaken();
    }

    throw error;
  }
}

async function lockTableAtVersion(
  transaction: DatabaseTransaction,
  actor: Actor,
  tableId: string,
  expectedVersion: number,
): Promise<TableRow> {
  const [table] = await lockTables(transaction, [tableId], actor.locationId);

  if (!table) {
    throw new NotFoundError("table");
  }

  if (table.version !== expectedVersion) {
    throw new ConcurrencyError("table", table.id);
  }

  return table;
}

async function isOccupied(
  transaction: DatabaseTransaction,
  tableId: string,
): Promise<boolean> {
  return (await findOccupyingSessions(transaction, [tableId])).has(tableId);
}

export async function updateTable(
  database: Database,
  actor: Actor,
  tableId: string,
  input: TableInput & { active: boolean; expectedVersion: number },
): Promise<{ id: string; version: number }> {
  assertPermission(actor, "restaurant.tables.manage");
  assertMinimumCapacity(input);

  try {
    return await withTransaction(database, async (transaction) => {
      const table = await lockTableAtVersion(
        transaction,
        actor,
        tableId,
        input.expectedVersion,
      );
      const areaChanged = table.restaurantAreaId !== input.restaurantAreaId;

      if (areaChanged) {
        await assertTableArea(transaction, actor.locationId, input.restaurantAreaId);
        await assertSectionAllowsArea(transaction, tableId, input.restaurantAreaId);
      }

      if (
        (areaChanged || (table.active && !input.active)) &&
        (await isOccupied(transaction, tableId))
      ) {
        throw new ConflictError(
          "TABLE_ALREADY_OCCUPIED",
          `Table ${table.tableNumber} has an active session. End it first.`,
        );
      }

      const [updated] = await transaction
        .update(restaurantTables)
        .set({
          restaurantAreaId: input.restaurantAreaId,
          tableNumber: input.tableNumber,
          name: input.name,
          capacity: input.capacity,
          minimumCapacity: input.minimumCapacity,
          sortOrder: input.sortOrder ?? table.sortOrder,
          active: input.active,
          version: nextVersion(restaurantTables.version),
        })
        .where(eq(restaurantTables.id, tableId))
        .returning({ id: restaurantTables.id, version: restaurantTables.version });

      return updated!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw tableNumberTaken();
    }

    throw error;
  }
}

async function assertSectionAllowsArea(
  transaction: DatabaseTransaction,
  tableId: string,
  areaId: string,
): Promise<void> {
  const [section] = await transaction
    .select({ areaId: serverSections.restaurantAreaId })
    .from(serverSectionTables)
    .innerJoin(
      serverSections,
      eq(serverSections.id, serverSectionTables.serverSectionId),
    )
    .where(
      and(
        eq(serverSectionTables.restaurantTableId, tableId),
        eq(serverSectionTables.active, true),
      ),
    );

  if (section?.areaId && section.areaId !== areaId) {
    throw new BusinessRuleError(
      "TABLE_SECTION_AREA_MISMATCH",
      "This table's section belongs to another area. Take it out of the section first.",
    );
  }
}

/** The explicit DIRTY to CLEAN step. It's never automatic. */
export async function cleanTable(
  database: Database,
  actor: Actor,
  tableId: string,
  input: { expectedVersion: number },
): Promise<{ id: string; version: number }> {
  assertPermission(actor, "restaurant.clean-table");

  return withTransaction(database, async (transaction) => {
    const table = await lockTableAtVersion(
      transaction,
      actor,
      tableId,
      input.expectedVersion,
    );

    if (await isOccupied(transaction, tableId)) {
      throw new ConflictError(
        "TABLE_ALREADY_OCCUPIED",
        `Table ${table.tableNumber} has an active session.`,
      );
    }

    if (table.condition !== "DIRTY") {
      throw new BusinessRuleError(
        "TABLE_NOT_DIRTY",
        `Table ${table.tableNumber} doesn't need cleaning.`,
      );
    }

    return writeTableCondition(transaction, {
      tableId,
      condition: "CLEAN",
      reason: "Cleaned",
      userId: actor.userId,
      occurredAt: new Date(),
    });
  });
}

/**
 * Manager changes such as out of service and back, with an explicit target condition.
 * An occupied table must have its session resolved first, because a physical state that
 * contradicts a seated party has no meaning here.
 */
export async function changeTableCondition(
  database: Database,
  actor: Actor,
  tableId: string,
  input: {
    condition: TableCondition;
    reason: string | null;
    expectedVersion: number;
  },
): Promise<{ id: string; version: number }> {
  assertPermission(actor, "restaurant.condition.manage");

  return withTransaction(database, async (transaction) => {
    const table = await lockTableAtVersion(
      transaction,
      actor,
      tableId,
      input.expectedVersion,
    );

    if (await isOccupied(transaction, tableId)) {
      throw new ConflictError(
        "TABLE_ALREADY_OCCUPIED",
        `Table ${table.tableNumber} has an active session. End it first.`,
      );
    }

    if (table.condition === input.condition) {
      throw new BusinessRuleError(
        "CONDITION_UNCHANGED",
        `Table ${table.tableNumber} is already in that condition.`,
      );
    }

    return writeTableCondition(transaction, {
      tableId,
      condition: input.condition,
      reason: input.reason,
      userId: actor.userId,
      occurredAt: new Date(),
    });
  });
}
