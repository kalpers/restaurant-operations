import { and, asc, eq, ne, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { DEFAULT_MANAGER_LOG_CATEGORIES, managerLogCategories } from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { AuthorizationError, BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { assertPermission } from "./access";

// Phase 33 manager log categories (policies 17–18). Organization-wide rows that managers add
// to, rename, reorder and deactivate; never deleted. Entries name their category by its
// code, which never changes, so renaming or deactivating one changes no entry.

export type ManagerLogCategoryView = {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  active: boolean;
  version: number;
};

type CategoryRow = typeof managerLogCategories.$inferSelect;

const viewOf = (row: CategoryRow): ManagerLogCategoryView => ({
  id: row.id,
  code: row.code,
  name: row.name,
  sortOrder: row.sortOrder,
  active: row.active,
  version: row.version,
});

/**
 * Amendment 2: an organization without any category gets the six defaults the first time
 * one is needed (organizations made by fixtures or after the seed ran). Idempotent.
 */
export async function ensureDefaultLogCategories(executor: DatabaseExecutor, organizationId: string): Promise<void> {
  const [any] = await executor
    .select({ id: managerLogCategories.id })
    .from(managerLogCategories)
    .where(eq(managerLogCategories.organizationId, organizationId))
    .limit(1);

  if (any) {
    return;
  }

  await executor
    .insert(managerLogCategories)
    .values(DEFAULT_MANAGER_LOG_CATEGORIES.map((category) => ({ organizationId, ...category })))
    .onConflictDoNothing({ target: [managerLogCategories.organizationId, managerLogCategories.code] });
}

async function readCategories(executor: DatabaseExecutor, organizationId: string): Promise<CategoryRow[]> {
  await ensureDefaultLogCategories(executor, organizationId);

  return executor
    .select()
    .from(managerLogCategories)
    .where(eq(managerLogCategories.organizationId, organizationId))
    .orderBy(asc(managerLogCategories.sortOrder), asc(managerLogCategories.name), asc(managerLogCategories.code));
}

/** Every category, active first in display order. Readers of the log need them for names. */
export async function listLogCategories(executor: DatabaseExecutor, actor: Actor): Promise<ManagerLogCategoryView[]> {
  if (!actor.permissions.has("manager-log.view") && !actor.permissions.has("manager-log.categories")) {
    throw new AuthorizationError();
  }

  return (await readCategories(executor, actor.organizationId)).map(viewOf);
}

/** Policy 18: a new entry may use only an active category of the organization. */
export async function assertActiveLogCategory(executor: DatabaseExecutor, organizationId: string, code: string): Promise<void> {
  await ensureDefaultLogCategories(executor, organizationId);

  const [row] = await executor
    .select({ active: managerLogCategories.active })
    .from(managerLogCategories)
    .where(and(eq(managerLogCategories.organizationId, organizationId), eq(managerLogCategories.code, code)));

  if (!row?.active) {
    throw new BusinessRuleError("CATEGORY_NOT_AVAILABLE", "Choose one of the log's active categories.");
  }
}

/** Upper-case letters, digits and underscores, from a name when no code is given. */
export function categoryCodeFrom(name: string): string {
  const code = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);

  return /^[A-Z]/.test(code) ? code : `C_${code}`.slice(0, 30);
}

export async function addLogCategory(
  database: Database,
  actor: Actor,
  input: { name: string; code?: string | null; sortOrder?: number | null },
): Promise<ManagerLogCategoryView> {
  assertPermission(actor, "manager-log.categories");

  const name = input.name.trim();
  const code = input.code?.trim() ? input.code.trim().toUpperCase() : categoryCodeFrom(name);

  if (!/^[A-Z][A-Z0-9_]{1,29}$/.test(code)) {
    throw new BusinessRuleError(
      "INVALID_CATEGORY_CODE",
      "A code is 2 to 30 capital letters, digits or underscores, starting with a letter.",
    );
  }

  return withTransaction(database, async (transaction) => {
    const existing = await readCategories(transaction, actor.organizationId);

    if (existing.some((row) => row.code === code)) {
      throw new ConflictError("CATEGORY_CODE_IN_USE", "A category with that code already exists.");
    }

    const sortOrder = input.sortOrder ?? Math.max(0, ...existing.map((row) => row.sortOrder)) + 10;
    const [row] = await transaction
      .insert(managerLogCategories)
      .values({
        organizationId: actor.organizationId,
        code,
        name,
        sortOrder,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      })
      .returning();

    return viewOf(row!);
  });
}

/** Rename, reorder, deactivate or reactivate one category (optimistic `version`). */
export async function updateLogCategory(
  database: Database,
  actor: Actor,
  categoryId: string,
  input: { name: string; sortOrder: number; active: boolean; expectedVersion: number },
): Promise<ManagerLogCategoryView> {
  assertPermission(actor, "manager-log.categories");

  return withTransaction(database, async (transaction) => {
    const [row] = await transaction
      .select()
      .from(managerLogCategories)
      .where(and(eq(managerLogCategories.id, categoryId), eq(managerLogCategories.organizationId, actor.organizationId)))
      .for("update");

    if (!row) {
      throw new NotFoundError("manager log category");
    }

    if (row.version !== input.expectedVersion) {
      throw new ConcurrencyError("manager log category", categoryId);
    }

    if (row.active && !input.active) {
      const [other] = await transaction
        .select({ id: managerLogCategories.id })
        .from(managerLogCategories)
        .where(
          and(
            eq(managerLogCategories.organizationId, actor.organizationId),
            eq(managerLogCategories.active, true),
            ne(managerLogCategories.id, row.id),
          ),
        )
        .limit(1);

      if (!other) {
        throw new BusinessRuleError("LAST_ACTIVE_CATEGORY", "Keep at least one active category.");
      }
    }

    const [updated] = await transaction
      .update(managerLogCategories)
      .set({
        name: input.name.trim(),
        sortOrder: input.sortOrder,
        active: input.active,
        updatedByUserId: actor.userId,
        updatedAt: new Date(),
        version: sql`${managerLogCategories.version} + 1`,
      })
      .where(eq(managerLogCategories.id, row.id))
      .returning();

    return viewOf(updated!);
  });
}
